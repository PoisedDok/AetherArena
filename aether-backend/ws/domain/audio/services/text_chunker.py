"""
@.architecture
Incoming: MessageHandler._wrap_with_tts() --- {str accumulated_text, TtsConfig}
Processing: Intelligent text chunking for TTS (priority-based break detection: punctuation > semantic words > word count), find_break_point (scan words within target±3, score by priority+distance), process (extract sentence, update state, return remaining), should_process (check punctuation endings OR word count target) --- {4 jobs: JOB_VALIDATE_SCHEMA, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_TRANSFORM_DATA}
Outgoing: MessageHandler._wrap_with_tts() --- {str sentence, str remaining_text}

Text Chunker - Intelligent text chunking for TTS generation

Adapted from Kokoro-Conversational/src/utils/text_chunker.py
Keeps exact algorithm logic, changes config loading pattern.

Key Features:
- First sentence: ~8 words (low latency, fast first audio)
- Subsequent chunks: ~18 words (natural pacing)
- Priority-based break detection:
  * Punctuation (.!? = 5, ;: = 4, , = 3, - = 2)
  * Semantic breaks (however/therefore = 4, while/although = 3, and/but = 2)
  * Word count threshold (fallback if no good break point)

Pattern: Kokoro parallel pipeline - chunk while LLM streams
"""



class TextChunker:
    """
    Intelligent text chunking for voice generation.
    
    Adapted from Kokoro-Conversational with configuration injection.
    """
    
    def __init__(self, first_size: int = 8, target_size: int = 18):
        """
        Initialize TextChunker with target word counts.
        
        Args:
            first_size: Target words for first sentence (default 8 for low latency)
            target_size: Target words for subsequent chunks (default 18 for natural pacing)
        """
        self.first_size = first_size
        self.target_size = target_size
        self.current_text = []
        self.found_first_sentence = False
        
        # Semantic break words with priority scores (exact from Kokoro)
        self.semantic_breaks = {
            "however": 4,
            "therefore": 4,
            "furthermore": 4,
            "moreover": 4,
            "nevertheless": 4,
            "while": 3,
            "although": 3,
            "unless": 3,
            "since": 3,
            "and": 2,
            "but": 2,
            "because": 2,
            "then": 2,
        }
        
        # Punctuation priorities (exact from Kokoro)
        self.punctuation_priorities = {
            ".": 5,  # Sentence end
            "!": 5,
            "?": 5,
            ";": 4,  # Clause end
            ":": 4,
            ",": 3,  # Phrase end
            "-": 2,  # Word connector
        }
    
    def should_process(self, text: str) -> bool:
        """
        Determines if text should be processed based on length or punctuation.
        
        Args:
            text: The accumulated text to check
            
        Returns:
            True if text is ready to process (has punctuation ending OR meets word count)
        """
        if any(text.endswith(p) for p in self.punctuation_priorities):
            return True
        
        words = text.split()
        target = self.first_size if not self.found_first_sentence else self.target_size
        return len(words) >= target
    
    def find_break_point(self, words: list, target_size: int) -> int:
        """
        Finds optimal break point in text using priority-based scoring.
        
        Algorithm (exact from Kokoro):
        1. Scan words within target±3 range
        2. Score each word: max(semantic_priority, punctuation_priority)
        3. Sort by priority (desc), then by distance to target (asc)
        4. Return highest-scoring break point
        
        Args:
            words: List of words to find break point in
            target_size: Target word count for chunk
            
        Returns:
            Index of optimal break point (1-based, inclusive)
        """
        if len(words) <= target_size:
            return len(words)
        
        break_points = []
        
        # Scan words within target±3 range
        for i, word in enumerate(words[: target_size + 3]):
            word_lower = word.lower()
            
            # Check semantic break priority
            priority = self.semantic_breaks.get(word_lower, 0)
            
            # Check punctuation priority (higher than semantic if both present)
            for punct, punct_priority in self.punctuation_priorities.items():
                if word.endswith(punct):
                    priority = max(priority, punct_priority)
            
            # Record break point with priority and distance score
            if priority > 0:
                break_points.append((i, priority, -abs(i - target_size)))
        
        # No good break points found, use target size
        if not break_points:
            return target_size
        
        # Sort by priority (desc), then distance to target (asc)
        break_points.sort(key=lambda x: (x[1], x[2]), reverse=True)
        return break_points[0][0] + 1
    
    def process(self, text: str, _audio_queue=None) -> str:
        """
        Process text chunk and return sentence.
        
        ADAPTATION: Returns sentence string instead of queueing to audio_queue.
        Caller (MessageHandler) handles TTS generation via asyncio.to_thread().
        
        Args:
            text: The accumulated text to process
            _audio_queue: Unused (kept for API compatibility with Kokoro original)
            
        Returns:
            Extracted sentence (or empty string if no valid sentence)
        """
        if not text:
            return ""
        
        words = text.split()
        if not words:
            return ""
        
        # Determine target size based on whether first sentence found
        target_size = self.first_size if not self.found_first_sentence else self.target_size
        split_point = self.find_break_point(words, target_size)
        
        if split_point:
            chunk = " ".join(words[:split_point]).strip()
            
            # Validate chunk has alphanumeric characters
            if chunk and any(c.isalnum() for c in chunk):
                # Clean trailing commas (Kokoro pattern)
                chunk = chunk.rstrip(",")
                
                # Mark first sentence as found
                self.found_first_sentence = True
                
                # Return sentence for TTS generation
                return chunk
        
        return ""
