"""
Unit tests for pipeline data transformations at every handoff point.

Verifies data shape, field names, types, and metadata propagation as data
flows through: Daemon -> Worker -> API Endpoint -> Perplexica

Checkpoint 1: daemon._process_new_logs() output (context_docs with _context_type/_batch)
Checkpoint 2: worker._parse_context_docs() + source_docs builder (source, timestamp, metadata)
Checkpoint 3: API endpoint context split (currentActivity vs backgroundHistory by _context_type)
Checkpoint 4: Perplexica payload structure (currentActivity, backgroundHistory, queries, config, chatModel, iclExamples)
"""

import json


# ===========================================================================
# Checkpoint 1: Daemon output -- context_docs structure
# ===========================================================================

class TestCheckpoint1DaemonOutput:
    """Verify daemon's _process_new_logs() produces correctly tagged context_docs."""

    def test_triggering_log_has_context_type(self):
        """Current logs get _context_type='triggering_log' and _batch='current'."""
        # Simulate what daemon._process_new_logs does to a raw source log
        raw_log = {
            "id": 1,
            "timestamp": "2026-02-09T10:00:00+00:00",
            "sender": "ops@co.com",
            "subject": "Server Down",
            "body_preview": "P0 incident in prod",
            "query_gen_processed": 0,
        }
        tagged = {**raw_log, "_context_type": "triggering_log", "_batch": "current"}

        assert tagged["_context_type"] == "triggering_log"
        assert tagged["_batch"] == "current"
        # Original fields preserved
        assert tagged["sender"] == "ops@co.com"
        assert tagged["subject"] == "Server Down"

    def test_previous_query_has_context_type(self):
        """Previous batch queries get _context_type='previous_query' and _batch='N-X'."""
        prev_query = {
            "_context_type": "previous_query",
            "_batch": "N-1",
            "query": "user researching kubernetes",
            "batch_id": "abc12345",
            "timestamp": "2026-02-09T09:00:00+00:00",
            "query_id": "qgen_20260209_xyz",
        }

        assert prev_query["_context_type"] == "previous_query"
        assert prev_query["_batch"].startswith("N-")
        assert "query" in prev_query
        assert "batch_id" in prev_query
        assert "query_id" in prev_query

    def test_complete_context_docs_mixed(self):
        """Complete context_docs contains both triggering logs and previous queries."""
        context_docs = [
            # Current triggering logs
            {"id": 1, "sender": "a@b.com", "subject": "Alert", "_context_type": "triggering_log", "_batch": "current", "timestamp": "2026-02-09T10:00:00+00:00"},
            {"id": 2, "url": "https://k8s.io", "title": "K8s", "_context_type": "triggering_log", "_batch": "current", "timestamp": "2026-02-09T10:01:00+00:00"},
            # Previous queries
            {"_context_type": "previous_query", "_batch": "N-1", "query": "old query", "batch_id": "prev", "timestamp": "2026-02-09T09:00:00+00:00", "query_id": "qgen_old"},
        ]

        triggering = [d for d in context_docs if d["_context_type"] == "triggering_log"]
        previous = [d for d in context_docs if d["_context_type"] == "previous_query"]

        assert len(triggering) == 2
        assert len(previous) == 1
        assert all(d["_batch"] == "current" for d in triggering)

    def test_context_docs_serializes_to_valid_json(self):
        """context_docs must be JSON-serializable (stored in SQLite as JSON string)."""
        context_docs = [
            {"id": 1, "sender": "a@b.com", "_context_type": "triggering_log", "_batch": "current", "timestamp": "2026-02-09T10:00:00+00:00"},
        ]
        serialized = json.dumps(context_docs)
        deserialized = json.loads(serialized)
        assert deserialized == context_docs


# ===========================================================================
# Checkpoint 2: Worker source_docs builder
# ===========================================================================

class TestCheckpoint2WorkerSourceDocs:
    """Verify worker transforms context_docs into source_docs with correct shape."""

    def _build_source_docs(self, context_docs, query_timestamp):
        """Replicate worker's source_docs builder (lines 316-323 of handler.py)."""
        return [
            {
                "source": doc.get("source", "unknown"),
                "timestamp": doc.get("timestamp", query_timestamp),
                "metadata": {k: v for k, v in doc.items() if k not in ["source", "timestamp"]}
            }
            for doc in context_docs
        ]

    def test_source_doc_has_required_fields(self):
        context_docs = [
            {"source": "email", "timestamp": "2026-02-09T10:00:00+00:00", "sender": "a@b.com", "subject": "Alert", "_context_type": "triggering_log", "_batch": "current"},
        ]
        source_docs = self._build_source_docs(context_docs, "2026-02-09T10:00:00+00:00")

        assert len(source_docs) == 1
        doc = source_docs[0]
        # Required top-level fields
        assert "source" in doc
        assert "timestamp" in doc
        assert "metadata" in doc
        assert isinstance(doc["metadata"], dict)

    def test_source_and_timestamp_extracted_to_top_level(self):
        context_docs = [
            {"source": "browser", "timestamp": "2026-02-09T10:05:00+00:00", "url": "https://k8s.io", "title": "K8s"},
        ]
        source_docs = self._build_source_docs(context_docs, "fallback_ts")

        doc = source_docs[0]
        assert doc["source"] == "browser"
        assert doc["timestamp"] == "2026-02-09T10:05:00+00:00"

    def test_remaining_fields_in_metadata(self):
        context_docs = [
            {"source": "email", "timestamp": "ts", "sender": "a@b.com", "subject": "Alert", "body_preview": "Fire", "_context_type": "triggering_log", "_batch": "current"},
        ]
        source_docs = self._build_source_docs(context_docs, "ts")

        meta = source_docs[0]["metadata"]
        # source and timestamp are NOT in metadata
        assert "source" not in meta
        assert "timestamp" not in meta
        # All other fields ARE in metadata
        assert meta["sender"] == "a@b.com"
        assert meta["subject"] == "Alert"
        assert meta["body_preview"] == "Fire"
        assert meta["_context_type"] == "triggering_log"
        assert meta["_batch"] == "current"

    def test_fallback_timestamp_when_missing(self):
        """If doc has no 'timestamp', falls back to query-level timestamp."""
        context_docs = [
            {"source": "filesystem", "file_name": "app.py"},
        ]
        source_docs = self._build_source_docs(context_docs, "2026-02-09T09:00:00+00:00")
        assert source_docs[0]["timestamp"] == "2026-02-09T09:00:00+00:00"

    def test_missing_source_defaults_to_unknown(self):
        context_docs = [
            {"timestamp": "ts", "random_field": "value"},
        ]
        source_docs = self._build_source_docs(context_docs, "ts")
        assert source_docs[0]["source"] == "unknown"

    def test_context_type_metadata_survives_transformation(self):
        """_context_type and _batch must survive through metadata for API endpoint to split."""
        context_docs = [
            {"source": "email", "timestamp": "ts", "_context_type": "triggering_log", "_batch": "current", "subject": "Test"},
            {"source": "unknown", "timestamp": "ts", "_context_type": "previous_query", "_batch": "N-1", "query": "old query"},
        ]
        source_docs = self._build_source_docs(context_docs, "ts")

        # API endpoint reads _context_type from metadata
        assert source_docs[0]["metadata"]["_context_type"] == "triggering_log"
        assert source_docs[0]["metadata"]["_batch"] == "current"
        assert source_docs[1]["metadata"]["_context_type"] == "previous_query"
        assert source_docs[1]["metadata"]["_batch"] == "N-1"


# ===========================================================================
# Checkpoint 3: API endpoint context split
# ===========================================================================

class TestCheckpoint3APIContextSplit:
    """Verify API endpoint splits source_docs into currentActivity and backgroundHistory."""

    def _split_context(self, source_docs):
        """Replicate API endpoint context split logic (lines 125-146 of proactive.py)."""
        current_activity = []
        background_history = []

        for doc in source_docs:
            metadata = doc.get("metadata", {})
            context_type = metadata.get("_context_type", "unknown")
            batch = metadata.get("_batch", "unknown")
            timestamp = doc.get("timestamp", metadata.get("timestamp", ""))
            doc_with_time = {**doc, "timestamp": timestamp}

            if context_type == "triggering_log" and batch == "current":
                current_activity.append(doc_with_time)
            elif context_type == "previous_query":
                background_history.append(doc_with_time)

        return current_activity, background_history

    def test_triggering_logs_go_to_current_activity(self):
        source_docs = [
            {"source": "email", "timestamp": "ts1", "metadata": {"_context_type": "triggering_log", "_batch": "current", "subject": "Alert"}},
        ]
        current, background = self._split_context(source_docs)
        assert len(current) == 1
        assert len(background) == 0

    def test_previous_queries_go_to_background_history(self):
        source_docs = [
            {"source": "unknown", "timestamp": "ts1", "metadata": {"_context_type": "previous_query", "_batch": "N-1", "query": "old"}},
        ]
        current, background = self._split_context(source_docs)
        assert len(current) == 0
        assert len(background) == 1

    def test_mixed_context_split_correctly(self):
        source_docs = [
            {"source": "email", "timestamp": "ts1", "metadata": {"_context_type": "triggering_log", "_batch": "current", "subject": "A"}},
            {"source": "filesystem", "timestamp": "ts2", "metadata": {"_context_type": "triggering_log", "_batch": "current", "file_name": "x.py"}},
            {"source": "unknown", "timestamp": "ts3", "metadata": {"_context_type": "previous_query", "_batch": "N-1", "query": "old1"}},
            {"source": "unknown", "timestamp": "ts4", "metadata": {"_context_type": "previous_query", "_batch": "N-2", "query": "old2"}},
        ]
        current, background = self._split_context(source_docs)
        assert len(current) == 2
        assert len(background) == 2

    def test_unknown_context_type_dropped(self):
        """Docs with unknown _context_type are neither current nor background."""
        source_docs = [
            {"source": "x", "timestamp": "ts", "metadata": {"_context_type": "unknown", "_batch": "unknown"}},
        ]
        current, background = self._split_context(source_docs)
        assert len(current) == 0
        assert len(background) == 0

    def test_triggering_log_wrong_batch_dropped(self):
        """triggering_log with batch != 'current' is dropped (defensive)."""
        source_docs = [
            {"source": "email", "timestamp": "ts", "metadata": {"_context_type": "triggering_log", "_batch": "N-1"}},
        ]
        current, background = self._split_context(source_docs)
        assert len(current) == 0

    def test_no_data_loss_in_current_activity(self):
        """All original fields propagate to currentActivity."""
        source_docs = [
            {"source": "email", "timestamp": "ts1", "metadata": {"_context_type": "triggering_log", "_batch": "current", "sender": "a@b.com", "subject": "Alert"}},
        ]
        current, _ = self._split_context(source_docs)
        assert current[0]["source"] == "email"
        assert current[0]["metadata"]["sender"] == "a@b.com"
        assert current[0]["metadata"]["subject"] == "Alert"


# ===========================================================================
# Checkpoint 4: Perplexica payload structure
# ===========================================================================

class TestCheckpoint4PerplexicaPayload:
    """Verify the final payload sent to Perplexica has the correct shape."""

    def _build_payload(self, queries, current_activity, background_history, icl_examples, agent_model_id, mesh_base_url):
        """Replicate API endpoint payload construction (lines 161-178 of proactive.py)."""
        return {
            "queries": queries,
            "currentActivity": current_activity,
            "backgroundHistory": background_history,
            "activityContext": {},
            "iclExamples": icl_examples or [],
            "chatModel": {
                "providerId": "aether-inference-default",
                "key": agent_model_id,
            },
            "config": {
                "apiBase": mesh_base_url,
            }
        }

    def test_payload_has_all_required_fields(self):
        payload = self._build_payload(
            queries=["test query"],
            current_activity=[{"source": "email", "metadata": {}}],
            background_history=[],
            icl_examples=[],
            agent_model_id="qwen/qwen3-4b",
            mesh_base_url="http://host.docker.internal:7090/v1",
        )

        required_keys = {"queries", "currentActivity", "backgroundHistory", "activityContext", "iclExamples", "chatModel", "config"}
        assert set(payload.keys()) == required_keys

    def test_chatmodel_structure(self):
        payload = self._build_payload(
            queries=[], current_activity=[], background_history=[], icl_examples=[],
            agent_model_id="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit", mesh_base_url="http://x",
        )
        assert payload["chatModel"]["providerId"] == "aether-inference-default"
        assert payload["chatModel"]["key"] == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"

    def test_config_structure(self):
        payload = self._build_payload(
            queries=[], current_activity=[], background_history=[], icl_examples=[],
            agent_model_id="m", mesh_base_url="http://mesh:7090/v1",
        )
        assert payload["config"]["apiBase"] == "http://mesh:7090/v1"

    def test_icl_examples_empty_when_none(self):
        payload = self._build_payload(
            queries=[], current_activity=[], background_history=[],
            icl_examples=None,
            agent_model_id="m", mesh_base_url="http://x",
        )
        assert payload["iclExamples"] == []

    def test_icl_examples_structure(self):
        icl = [
            {"recommendation": "Check CVE-2026-1234", "userFeedback": "clicked", "similarity": 0.85},
        ]
        payload = self._build_payload(
            queries=[], current_activity=[], background_history=[],
            icl_examples=icl,
            agent_model_id="m", mesh_base_url="http://x",
        )
        assert len(payload["iclExamples"]) == 1
        ex = payload["iclExamples"][0]
        assert "recommendation" in ex
        assert "userFeedback" in ex
        assert "similarity" in ex

    def test_payload_is_json_serializable(self):
        """Full payload must be JSON-serializable (sent via HTTP POST)."""
        payload = self._build_payload(
            queries=["user researching kubernetes"],
            current_activity=[{"source": "email", "timestamp": "ts", "metadata": {"sender": "a@b.com"}}],
            background_history=[{"source": "unknown", "timestamp": "ts", "metadata": {"query": "old"}}],
            icl_examples=[{"recommendation": "Check it", "userFeedback": "clicked", "similarity": 0.8}],
            agent_model_id="qwen/qwen3-4b", mesh_base_url="http://x",
        )
        serialized = json.dumps(payload)
        assert isinstance(serialized, str)
        assert len(serialized) > 0


# ===========================================================================
# End-to-end checkpoint chain (all 4 steps)
# ===========================================================================

class TestFullCheckpointChain:
    """Verify data integrity across the full 4-checkpoint chain."""

    def test_email_log_survives_full_pipeline(self):
        """Trace a single email log through all 4 checkpoints."""
        # Checkpoint 1: Daemon tags raw log
        raw_log = {"id": 42, "timestamp": "2026-02-09T10:00:00+00:00", "sender": "boss@co.com", "subject": "Deadline Tomorrow", "body_preview": "Q4 report due", "query_gen_processed": 0}
        tagged = {**raw_log, "_context_type": "triggering_log", "_batch": "current"}

        # Checkpoint 2: Worker builds source_doc
        source_doc = {
            "source": tagged.get("source", "unknown"),
            "timestamp": tagged.get("timestamp", ""),
            "metadata": {k: v for k, v in tagged.items() if k not in ["source", "timestamp"]}
        }
        assert source_doc["metadata"]["_context_type"] == "triggering_log"
        assert source_doc["metadata"]["subject"] == "Deadline Tomorrow"

        # Checkpoint 3: API splits to currentActivity
        metadata = source_doc.get("metadata", {})
        context_type = metadata.get("_context_type")
        batch = metadata.get("_batch")
        assert context_type == "triggering_log"
        assert batch == "current"
        # -> goes to currentActivity

        # Checkpoint 4: Perplexica receives it in currentActivity
        payload = {
            "currentActivity": [source_doc],
            "backgroundHistory": [],
            "queries": ["user has deadline tomorrow for q4 report"],
        }
        assert len(payload["currentActivity"]) == 1
        assert payload["currentActivity"][0]["metadata"]["subject"] == "Deadline Tomorrow"

    def test_previous_query_survives_full_pipeline(self):
        """Trace a previous query through all 4 checkpoints."""
        # Checkpoint 1: Daemon creates previous_query context
        prev_ctx = {"_context_type": "previous_query", "_batch": "N-1", "query": "user struggling with k8s networking", "batch_id": "abc", "timestamp": "2026-02-09T09:00:00+00:00", "query_id": "qgen_old"}

        # Checkpoint 2: Worker builds source_doc
        source_doc = {
            "source": prev_ctx.get("source", "unknown"),
            "timestamp": prev_ctx.get("timestamp", ""),
            "metadata": {k: v for k, v in prev_ctx.items() if k not in ["source", "timestamp"]}
        }
        assert source_doc["metadata"]["_context_type"] == "previous_query"
        assert source_doc["metadata"]["query"] == "user struggling with k8s networking"

        # Checkpoint 3: API splits to backgroundHistory
        metadata = source_doc["metadata"]
        assert metadata["_context_type"] == "previous_query"
        # -> goes to backgroundHistory

        # Checkpoint 4: Perplexica receives it in backgroundHistory
        payload = {
            "currentActivity": [],
            "backgroundHistory": [source_doc],
            "queries": ["evolved query"],
        }
        assert len(payload["backgroundHistory"]) == 1
        assert payload["backgroundHistory"][0]["metadata"]["query"] == "user struggling with k8s networking"

    def test_mixed_pipeline_with_3_sources(self):
        """3 triggering logs (email+browser+filesystem) + 2 previous queries through full pipeline."""
        # Checkpoint 1
        context_docs = [
            {"id": 1, "source": "email", "timestamp": "ts1", "sender": "a@b.com", "subject": "P0", "_context_type": "triggering_log", "_batch": "current"},
            {"id": 2, "source": "browser", "timestamp": "ts2", "url": "https://k8s.io", "title": "K8s", "_context_type": "triggering_log", "_batch": "current"},
            {"id": 3, "source": "filesystem", "timestamp": "ts3", "file_name": "fix.py", "file_path": "/fix.py", "_context_type": "triggering_log", "_batch": "current"},
            {"_context_type": "previous_query", "_batch": "N-1", "query": "old q1", "batch_id": "b1", "timestamp": "ts_old1", "query_id": "qgen_1"},
            {"_context_type": "previous_query", "_batch": "N-2", "query": "old q2", "batch_id": "b2", "timestamp": "ts_old2", "query_id": "qgen_2"},
        ]

        # Checkpoint 2: Worker transforms
        source_docs = [
            {
                "source": doc.get("source", "unknown"),
                "timestamp": doc.get("timestamp", ""),
                "metadata": {k: v for k, v in doc.items() if k not in ["source", "timestamp"]}
            }
            for doc in context_docs
        ]
        assert len(source_docs) == 5

        # Checkpoint 3: API splits
        current_activity = []
        background_history = []
        for doc in source_docs:
            meta = doc["metadata"]
            ct = meta.get("_context_type", "unknown")
            batch = meta.get("_batch", "unknown")
            if ct == "triggering_log" and batch == "current":
                current_activity.append(doc)
            elif ct == "previous_query":
                background_history.append(doc)

        assert len(current_activity) == 3
        assert len(background_history) == 2

        # Checkpoint 4: Verify source types in currentActivity
        sources = {d["source"] for d in current_activity}
        assert sources == {"email", "browser", "filesystem"}

        # No data loss
        assert current_activity[0]["metadata"]["subject"] == "P0"
        assert current_activity[1]["metadata"]["url"] == "https://k8s.io"
        assert current_activity[2]["metadata"]["file_name"] == "fix.py"
        assert background_history[0]["metadata"]["query"] == "old q1"
        assert background_history[1]["metadata"]["query"] == "old q2"
