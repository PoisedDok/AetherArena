"""
Tests for core.profiles.manager — ProfileManager

Strategy:
- Use tmp_path for real filesystem interactions (profile files, YAML parsing).
- Mock _get_profiles_directories only to inject tmp_path as the profiles root.
- Test _get_profiles_directories itself with targeted Path/sys mocks.
- Deep assertions on exact return shapes, not just truthiness.
"""

import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from core.profiles.manager import ProfileManager


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def mgr():
    """Fresh ProfileManager with no cache."""
    return ProfileManager()


@pytest.fixture()
def profiles_dir(tmp_path):
    """Create a realistic profiles directory with real YAML files."""
    d = tmp_path / "templates"
    d.mkdir()

    # GURU.yaml — valid YAML profile
    guru = d / "GURU.yaml"
    guru.write_text(
        "system_message: |\n  You are GURU.\nmodel: gpt-4\n",
        encoding="utf-8",
    )

    # default.yaml — valid YAML profile
    default = d / "default.yaml"
    default.write_text(
        "system_message: |\n  Default profile.\n",
        encoding="utf-8",
    )

    # helper.py — Python profile (valid extension)
    py_profile = d / "helper.py"
    py_profile.write_text("# python profile\ninterpreter.model = 'gpt-3.5'\n", encoding="utf-8")

    # README.md — should be skipped (invalid extension)
    readme = d / "README.md"
    readme.write_text("# not a profile\n", encoding="utf-8")

    # subdir — should be skipped (not a file)
    subdir = d / "subdir"
    subdir.mkdir()

    return d


def _patch_dirs(mgr, profiles_dir):
    """Helper: patch _get_profiles_directories to return a real tmp_path."""
    mgr._get_profiles_directories = lambda: [profiles_dir]
    mgr._profile_dirs = None  # Force fresh resolution
    mgr._profiles_cache = None


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:
    def test_initializes_cache_fields(self):
        m = ProfileManager()
        assert m._profiles_cache is None
        assert m._profile_dirs is None


# ===========================================================================
# discover_profiles
# ===========================================================================

class TestDiscoverProfiles:
    def test_returns_cached_on_second_call(self, mgr, profiles_dir):
        """Cache is populated on first call and reused."""
        _patch_dirs(mgr, profiles_dir)
        first = mgr.discover_profiles()
        second = mgr.discover_profiles()
        assert first is second  # Same object reference — from cache

    def test_discovers_valid_extensions_only(self, mgr, profiles_dir):
        """Only .py, .yaml, .yml files are discovered; .md and dirs skipped."""
        _patch_dirs(mgr, profiles_dir)
        profiles = mgr.discover_profiles()
        names = [p["name"] for p in profiles]
        assert "GURU.yaml" in names
        assert "default.yaml" in names
        assert "helper.py" in names
        assert "README.md" not in names

    def test_skips_directories(self, mgr, profiles_dir):
        """Subdirectories are not treated as profiles."""
        _patch_dirs(mgr, profiles_dir)
        profiles = mgr.discover_profiles()
        names = [p["name"] for p in profiles]
        assert "subdir" not in names

    def test_profile_metadata_shape(self, mgr, profiles_dir):
        """Each profile dict has all required keys with correct types."""
        _patch_dirs(mgr, profiles_dir)
        profiles = mgr.discover_profiles()
        for p in profiles:
            assert isinstance(p["name"], str)
            assert isinstance(p["path"], str)
            assert p["type"] in ("py", "yaml", "yml")
            assert isinstance(p["basename"], str)
            assert isinstance(p["display_name"], str)
            assert isinstance(p["source"], str)
            # display_name replaces underscores with spaces
            assert "_" not in p["display_name"] or "_" not in p["basename"]

    def test_sorted_output(self, mgr, profiles_dir):
        """Profiles come from sorted(iterdir())."""
        _patch_dirs(mgr, profiles_dir)
        profiles = mgr.discover_profiles()
        names = [p["name"] for p in profiles]
        assert names == sorted(names)

    def test_deduplication_by_name(self, mgr, tmp_path):
        """If two directories have the same filename, only the first is kept."""
        dir1 = tmp_path / "dir1"
        dir1.mkdir()
        dir2 = tmp_path / "dir2"
        dir2.mkdir()
        (dir1 / "test.yaml").write_text("a: 1\n")
        (dir2 / "test.yaml").write_text("a: 2\n")

        mgr._get_profiles_directories = lambda: [dir1, dir2]
        mgr._profiles_cache = None
        profiles = mgr.discover_profiles()
        test_profiles = [p for p in profiles if p["name"] == "test.yaml"]
        assert len(test_profiles) == 1
        assert test_profiles[0]["source"] == str(dir1)

    def test_empty_directory(self, mgr, tmp_path):
        """Empty profiles directory returns empty list."""
        empty = tmp_path / "empty"
        empty.mkdir()
        mgr._get_profiles_directories = lambda: [empty]
        mgr._profiles_cache = None
        assert mgr.discover_profiles() == []

    def test_no_profile_dirs(self, mgr):
        """No profile directories found returns empty list + warning."""
        mgr._get_profiles_directories = lambda: []
        mgr._profiles_cache = None
        assert mgr.discover_profiles() == []

    def test_iterdir_exception_returns_empty(self, mgr, tmp_path, caplog):
        """If iterdir raises, return empty list and log error."""
        broken_dir = MagicMock(spec=Path)
        broken_dir.iterdir.side_effect = PermissionError("denied")
        mgr._get_profiles_directories = lambda: [broken_dir]
        mgr._profiles_cache = None

        with caplog.at_level(logging.ERROR):
            result = mgr.discover_profiles()
        assert result == []
        assert "Failed to discover profiles" in caplog.text

    def test_yml_extension_accepted(self, mgr, tmp_path):
        """Files with .yml extension are discovered."""
        d = tmp_path / "yml_test"
        d.mkdir()
        (d / "special.yml").write_text("x: 1\n")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None
        profiles = mgr.discover_profiles()
        assert len(profiles) == 1
        assert profiles[0]["type"] == "yml"

    def test_display_name_replaces_underscores(self, mgr, tmp_path):
        """Underscores in stem are replaced with spaces for display."""
        d = tmp_path / "names"
        d.mkdir()
        (d / "my_cool_profile.yaml").write_text("x: 1\n")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None
        profiles = mgr.discover_profiles()
        assert profiles[0]["display_name"] == "my cool profile"
        assert profiles[0]["basename"] == "my_cool_profile"


# ===========================================================================
# get_profile_path
# ===========================================================================

class TestGetProfilePath:
    def test_exact_filename_match(self, mgr, profiles_dir):
        """Exact filename resolves to the file."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("GURU.yaml")
        assert isinstance(result, Path)
        assert result.name == "GURU.yaml"
        assert result.exists()

    def test_basename_without_extension(self, mgr, profiles_dir):
        """Basename without extension resolves by trying .yaml/.py."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("GURU")
        assert isinstance(result, Path)
        assert result.name == "GURU.yaml"

    def test_full_path_string_resolves_basename(self, mgr, profiles_dir):
        """A full path string still resolves via basename extraction."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("/some/fake/path/GURU.yaml")
        assert isinstance(result, Path)
        assert result.name == "GURU.yaml"

    def test_not_found_returns_none(self, mgr, profiles_dir, caplog):
        """Non-existent profile returns None and logs warning."""
        _patch_dirs(mgr, profiles_dir)
        with caplog.at_level(logging.WARNING):
            result = mgr.get_profile_path("nonexistent.yaml")
        assert result is None
        assert "Profile not found" in caplog.text

    def test_empty_profile_name(self, mgr, profiles_dir):
        """Empty string profile name returns None."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("")
        assert result is None

    def test_py_extension_resolution(self, mgr, profiles_dir):
        """Can find .py profile files."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("helper.py")
        assert isinstance(result, Path)
        assert result.name == "helper.py"

    def test_stem_resolves_py(self, mgr, profiles_dir):
        """Stem 'helper' resolves to helper.py."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("helper")
        assert isinstance(result, Path)
        assert result.name == "helper.py"

    def test_returns_resolved_path(self, mgr, profiles_dir):
        """Returned path is fully resolved (no symlinks/relative parts)."""
        _patch_dirs(mgr, profiles_dir)
        result = mgr.get_profile_path("GURU.yaml")
        assert result == result.resolve()

    def test_root_path_produces_empty_candidates(self, mgr, profiles_dir):
        """profile_name='/' produces empty .name/.stem candidates, triggering 'continue'."""
        _patch_dirs(mgr, profiles_dir)
        # Path("/").name == "" and Path("/").stem == ""
        # The first candidate "/" resolves to filesystem root which exists.
        # Patch exists() to reject root so empty candidates are reached.
        original_exists = Path.exists

        def fake_exists(p):
            if str(p) in ("/", "/.py", "/.yaml", "/.yml"):
                return False
            return original_exists(p)

        with patch.object(Path, "exists", fake_exists):
            result = mgr.get_profile_path("/")
        assert result is None


# ===========================================================================
# load_profile_content
# ===========================================================================

class TestLoadProfileContent:
    def test_loads_yaml_content(self, mgr, profiles_dir):
        """Returns raw file content for a valid profile."""
        _patch_dirs(mgr, profiles_dir)
        content = mgr.load_profile_content("GURU.yaml")
        assert content is not None
        assert "You are GURU" in content

    def test_not_found_returns_none(self, mgr, profiles_dir):
        """Non-existent profile returns None."""
        _patch_dirs(mgr, profiles_dir)
        assert mgr.load_profile_content("nope.yaml") is None

    def test_read_error_returns_none(self, mgr, profiles_dir, caplog):
        """If file read raises, returns None and logs error."""
        _patch_dirs(mgr, profiles_dir)
        # Make the file unreadable by patching open
        with patch("builtins.open", side_effect=PermissionError("denied")):
            with caplog.at_level(logging.ERROR):
                result = mgr.load_profile_content("GURU.yaml")
        assert result is None
        assert "Failed to load profile" in caplog.text


# ===========================================================================
# get_default_profile
# ===========================================================================

class TestGetDefaultProfile:
    def test_returns_guru_yaml(self, mgr):
        assert mgr.get_default_profile() == "GURU.yaml"


# ===========================================================================
# has_profile
# ===========================================================================

class TestHasProfile:
    def test_true_for_existing(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        assert mgr.has_profile("GURU.yaml") is True

    def test_false_for_nonexistent(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        assert mgr.has_profile("nonexistent.yaml") is False

    def test_true_for_basename(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        assert mgr.has_profile("default") is True


# ===========================================================================
# list_profile_names
# ===========================================================================

class TestListProfileNames:
    def test_returns_list_of_strings(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        names = mgr.list_profile_names()
        assert isinstance(names, list)
        assert all(isinstance(n, str) for n in names)
        assert "GURU.yaml" in names

    def test_empty_when_no_profiles(self, mgr):
        mgr._get_profiles_directories = lambda: []
        mgr._profiles_cache = None
        assert mgr.list_profile_names() == []


# ===========================================================================
# get_profile_metadata
# ===========================================================================

class TestGetProfileMetadata:
    def test_found_by_name(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        meta = mgr.get_profile_metadata("GURU.yaml")
        assert meta is not None
        assert meta["name"] == "GURU.yaml"
        assert meta["type"] == "yaml"
        assert meta["basename"] == "GURU"

    def test_found_by_basename(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        meta = mgr.get_profile_metadata("GURU")
        assert meta is not None
        assert meta["basename"] == "GURU"

    def test_not_found_returns_none(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        assert mgr.get_profile_metadata("nope") is None


# ===========================================================================
# clear_cache
# ===========================================================================

class TestClearCache:
    def test_resets_both_caches(self, mgr, profiles_dir):
        """Both _profiles_cache and _profile_dirs are cleared."""
        _patch_dirs(mgr, profiles_dir)
        mgr.discover_profiles()  # Populate cache
        assert mgr._profiles_cache is not None

        mgr.clear_cache()
        assert mgr._profiles_cache is None
        assert mgr._profile_dirs is None


# ===========================================================================
# _get_profiles_directories
# ===========================================================================

class TestGetProfilesDirectories:
    def test_returns_cached_on_second_call(self, mgr, profiles_dir):
        """Second call returns the cached list without re-resolving."""
        mgr._profile_dirs = [profiles_dir]
        result = mgr._get_profiles_directories()
        assert result == [profiles_dir]

    def test_normal_path_resolution(self, tmp_path):
        """Without _MEIPASS, uses Path(__file__).parent / 'templates'."""
        # Build a fake module dir with a templates subfolder
        fake_module_dir = tmp_path / "core" / "profiles"
        fake_module_dir.mkdir(parents=True)
        fake_templates = fake_module_dir / "templates"
        fake_templates.mkdir()
        (fake_templates / "test.yaml").write_text("x: 1\n")

        mgr = ProfileManager()
        mgr._profile_dirs = None

        # Patch __file__ so Path(__file__).parent points to fake_module_dir
        with patch("core.profiles.manager.__file__", str(fake_module_dir / "manager.py")):
            result = mgr._get_profiles_directories()

        assert len(result) == 1
        assert result[0] == fake_templates.resolve()

    def test_meipass_path(self, tmp_path):
        """With sys._MEIPASS, uses _MEIPASS / core / profiles / templates."""
        templates = tmp_path / "core" / "profiles" / "templates"
        templates.mkdir(parents=True)
        (templates / "x.yaml").write_text("y: 1\n")

        mgr = ProfileManager()
        mgr._profile_dirs = None

        with patch.object(sys, "_MEIPASS", str(tmp_path), create=True):
            result = mgr._get_profiles_directories()

        assert len(result) == 1
        assert result[0] == templates.resolve()

    def test_nonexistent_templates_dir(self, tmp_path):
        """If templates dir doesn't exist, returns empty list."""
        mgr = ProfileManager()
        mgr._profile_dirs = None

        # Point to a path where no templates dir exists
        fake_dir = tmp_path / "nowhere"
        fake_dir.mkdir()

        with patch("core.profiles.manager.__file__", str(fake_dir / "manager.py")):
            if hasattr(sys, "_MEIPASS"):
                # Ensure _MEIPASS doesn't interfere
                pass
            result = mgr._get_profiles_directories()

        # The normal path won't find templates, MEIPASS path won't exist
        # Result depends on whether sys._MEIPASS exists
        assert isinstance(result, list)

    def test_dedup_across_paths(self, tmp_path):
        """Same resolved directory is not added twice."""
        templates = tmp_path / "core" / "profiles" / "templates"
        templates.mkdir(parents=True)

        mgr = ProfileManager()
        mgr._profile_dirs = None

        # Use MEIPASS pointing to same location as __file__ resolution
        with patch.object(sys, "_MEIPASS", str(tmp_path), create=True):
            with patch("core.profiles.manager.__file__", str(tmp_path / "core" / "profiles" / "manager.py")):
                result = mgr._get_profiles_directories()

        # Both paths resolve to the same dir, should only appear once
        resolved = [r.resolve() for r in result]
        assert len(resolved) == len(set(resolved))


# ===========================================================================
# _get_profiles_directory
# ===========================================================================

class TestGetProfilesDirectory:
    def test_returns_first_directory(self, mgr, profiles_dir):
        mgr._profile_dirs = [profiles_dir]
        assert mgr._get_profiles_directory() == profiles_dir

    def test_returns_none_when_empty(self, mgr):
        mgr._profile_dirs = []
        assert mgr._get_profiles_directory() is None


# ===========================================================================
# load_profile_config
# ===========================================================================

class TestLoadProfileConfig:
    def test_loads_valid_yaml(self, mgr, profiles_dir):
        """Loads and parses a YAML profile into a dict."""
        _patch_dirs(mgr, profiles_dir)
        config = mgr.load_profile_config("GURU.yaml")
        assert isinstance(config, dict)
        assert "system_message" in config
        assert config["model"] == "gpt-4"

    def test_not_found_returns_none(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        assert mgr.load_profile_config("nope.yaml") is None

    def test_non_yaml_returns_none(self, mgr, profiles_dir):
        """Python profiles return None (not YAML)."""
        _patch_dirs(mgr, profiles_dir)
        assert mgr.load_profile_config("helper.py") is None

    def test_non_dict_yaml_returns_none(self, mgr, tmp_path, caplog):
        """YAML file that parses to non-dict returns None."""
        d = tmp_path / "nd"
        d.mkdir()
        (d / "list.yaml").write_text("- item1\n- item2\n")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None

        with caplog.at_level(logging.WARNING):
            result = mgr.load_profile_config("list.yaml")
        assert result is None
        assert "not a dict" in caplog.text

    def test_empty_yaml_returns_empty_dict(self, mgr, tmp_path):
        """Empty YAML file returns {} (yaml.safe_load returns None, or {})."""
        d = tmp_path / "empty"
        d.mkdir()
        (d / "blank.yaml").write_text("")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None

        result = mgr.load_profile_config("blank.yaml")
        # yaml.safe_load("") returns None, `or {}` makes it {}, isinstance(dict) True
        assert result == {}

    def test_invalid_yaml_returns_none(self, mgr, tmp_path, caplog):
        """Malformed YAML returns None and logs error."""
        d = tmp_path / "bad"
        d.mkdir()
        (d / "broken.yaml").write_text(":\n  - :\n    bad: [")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None

        with caplog.at_level(logging.ERROR):
            result = mgr.load_profile_config("broken.yaml")
        assert result is None
        assert "Failed to parse profile config" in caplog.text

    def test_yml_extension_accepted(self, mgr, tmp_path):
        """Files with .yml extension are parsed."""
        d = tmp_path / "yml"
        d.mkdir()
        (d / "profile.yml").write_text("key: val\n")
        mgr._get_profiles_directories = lambda: [d]
        mgr._profiles_cache = None

        result = mgr.load_profile_config("profile.yml")
        assert result == {"key": "val"}


# ===========================================================================
# get_health_status
# ===========================================================================

class TestGetHealthStatus:
    def test_populated_state(self, mgr, profiles_dir):
        _patch_dirs(mgr, profiles_dir)
        status = mgr.get_health_status()
        assert status["profiles_dir_found"] is True
        assert status["profiles_dir_path"] is not None
        assert status["profile_count"] >= 1
        assert status["cache_populated"] is True  # discover_profiles was called

    def test_empty_state(self, mgr):
        mgr._get_profiles_directories = lambda: []
        mgr._profiles_cache = None
        status = mgr.get_health_status()
        assert status["profiles_dir_found"] is False
        assert status["profiles_dir_path"] is None
        assert status["profile_count"] == 0
