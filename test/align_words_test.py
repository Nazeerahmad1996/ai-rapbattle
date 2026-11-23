from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from align_words import score_transcript


class IntelligibilityScoreTests(unittest.TestCase):
    def test_inserted_speech_is_penalized_even_when_reference_is_fully_present(self):
        result = score_transcript('one clear sentence', 'one clear sentence extra words')
        self.assertLess(result['wordMatchPct'], 95)
        self.assertEqual(result['wordErrors']['insertions'], 2)

    def test_substitution_and_deletion_both_count(self):
        result = score_transcript('the violet robot wins', 'the lime wins')
        self.assertEqual(result['wordMatchPct'], 50)
        self.assertEqual(result['wordErrors']['substitutions'], 1)
        self.assertEqual(result['wordErrors']['deletions'], 1)

    def test_common_number_spellings_are_normalized_without_fuzzy_name_credit(self):
        self.assertEqual(score_transcript('eighty-five minutes', '85 minutes')['wordMatchPct'], 100)
        self.assertLess(score_transcript('Claude wins', 'Lord wins')['wordMatchPct'], 95)

    def test_compound_hyphenation_is_not_a_speech_error(self):
        self.assertEqual(score_transcript('a sponsored shoutout', 'a sponsored shout-out')['wordMatchPct'], 100)

    def test_empty_reference_is_unverified(self):
        result = score_transcript('', 'hallucinated words')
        self.assertFalse(result['ok'])
        self.assertIsNone(result['wordMatchPct'])


if __name__ == '__main__':
    unittest.main()
