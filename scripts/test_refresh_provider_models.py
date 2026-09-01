import copy
import unittest
from unittest.mock import MagicMock, patch

from refresh_provider_models import (
    MANAGED_BY,
    RefreshError,
    fetch,
    is_openrouter_free,
    refresh_document,
)


def openrouter_model(model_id, *, free=False, vision=False, score=10):
    price = "0" if free else "0.000001"
    return {
        "id": model_id,
        "name": model_id.replace("/", ": "),
        "created": score,
        "architecture": {
            "input_modalities": ["text", "image"] if vision else ["text"],
            "output_modalities": ["text"],
            "tokenizer": "Other",
        },
        "pricing": {"prompt": price, "completion": price},
        "benchmarks": {"artificial_analysis": {"intelligence_index": score}},
    }


class RefreshProviderModelsTest(unittest.TestCase):
    def setUp(self):
        self.document = {
            "version": 1,
            "providers": {
                "openrouter": {
                    "models": {
                        "tl": [
                            {"id": "paid/model", "name": "Old name", "free": False},
                            {
                                "id": "free/pinned:free",
                                "name": "Pinned winner",
                                "free": True,
                                "pinned": True,
                            },
                            {"id": "gone/free:free", "name": "Gone", "free": True},
                        ],
                        "qaLLM": [],
                        "qaVLM": [],
                        "ocr": [],
                    },
                    "defaultTLModel": "paid/model",
                },
                "nvidia": {
                    "models": {
                        "tl": [
                            {"id": "nvidia/live", "name": "Live", "free": True},
                            {"id": "nvidia/gone", "name": "Gone", "free": True},
                        ]
                    },
                    "defaultTLModel": "nvidia/live",
                },
            },
        }
        self.openrouter = [
            openrouter_model("paid/model"),
            openrouter_model("free/pinned:free", free=True, score=1),
            openrouter_model("free/text:free", free=True, score=50),
            openrouter_model("free/vision:free", free=True, vision=True, score=60),
            openrouter_model("free/code-model:free", free=True, score=100),
        ]
        self.nvidia = [{"id": "nvidia/live", "owned_by": "nvidia"}]

    @patch("refresh_provider_models.urllib.request.urlopen")
    def test_fetch_sends_authorization_header(self, urlopen):
        response = MagicMock()
        response.read.return_value = b'{"data": []}'
        urlopen.return_value.__enter__.return_value = response

        fetch("https://example.test/models", authorization="Bearer nvidia-key")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer nvidia-key")

    def test_cache_charges_prevent_a_model_from_being_marked_free(self):
        model = openrouter_model("cached/model:free", free=True)
        model["pricing"]["input_cache_read"] = "0.0000001"

        self.assertFalse(is_openrouter_free(model))

    def test_refreshes_prices_and_replaces_free_entries(self):
        updated, changes = refresh_document(self.document, self.openrouter, self.nvidia)

        tl = updated["providers"]["openrouter"]["models"]["tl"]
        self.assertEqual(
            [entry["id"] for entry in tl],
            ["paid/model", "free/pinned:free", "free/vision:free", "free/text:free"],
        )
        self.assertEqual(tl[0]["pricing"]["promptPerMillion"], 1.0)
        self.assertTrue(tl[1]["pinned"])
        self.assertEqual(tl[2]["managedBy"], MANAGED_BY)
        self.assertNotIn("free/code-model:free", [entry["id"] for entry in tl])
        self.assertIn("openrouter/tl: removed free model gone/free:free", changes)

        vision = updated["providers"]["openrouter"]["models"]["ocr"]
        self.assertEqual([entry["id"] for entry in vision], ["free/vision:free"])

    def test_nvidia_shortlist_is_verified_not_expanded(self):
        updated, changes = refresh_document(self.document, self.openrouter, self.nvidia)
        models = updated["providers"]["nvidia"]["models"]["tl"]
        self.assertEqual([entry["id"] for entry in models], ["nvidia/live"])
        self.assertEqual(models[0]["pricing"]["note"], "Free credits")
        self.assertIn("nvidia/tl: removed unavailable model nvidia/gone", changes)

    def test_missing_default_aborts_the_whole_refresh(self):
        document = copy.deepcopy(self.document)
        document["providers"]["openrouter"]["defaultTLModel"] = "missing/default"
        with self.assertRaisesRegex(RefreshError, "defaults missing"):
            refresh_document(document, self.openrouter, self.nvidia)


if __name__ == "__main__":
    unittest.main()
