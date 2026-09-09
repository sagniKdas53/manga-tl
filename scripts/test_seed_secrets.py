import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from scripts.seed_secrets import seed_secrets


class SeedSecretsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_noninteractive_is_idempotent_and_secure(self):
        seed_secrets(self.root, non_interactive=True)
        password = (self.root / "secrets/db_password.txt").read_text()
        keys = self.root / "secrets/api_keys.json"
        self.assertEqual(json.loads(keys.read_text()), {})
        seed_secrets(self.root, non_interactive=True)
        self.assertEqual((self.root / "secrets/db_password.txt").read_text(), password)
        self.assertEqual((self.root / "secrets").stat().st_mode & 0o777, 0o700)
        self.assertEqual(keys.stat().st_mode & 0o777, 0o600)

    def test_import_preserves_existing_and_skips_blank(self):
        secret_dir = self.root / "secrets"
        secret_dir.mkdir()
        (secret_dir / "api_keys.json").write_text(
            json.dumps({"OPENAI_API_KEY": "old", "unknown": "keep"})
        )
        imported = self.root / "import.json"
        imported.write_text(
            json.dumps(
                {"OPENAI_API_KEY": "new", "GEMINI_API_KEY": "new", "EMPTY": "  "}
            )
        )
        seed_secrets(self.root, non_interactive=True, import_path=imported)
        self.assertEqual(
            json.loads((secret_dir / "api_keys.json").read_text()),
            {"OPENAI_API_KEY": "old", "unknown": "keep", "GEMINI_API_KEY": "new"},
        )

    def test_import_fills_existing_empty_value_and_missing_file_fails(self):
        secret_dir = self.root / "secrets"
        secret_dir.mkdir()
        (secret_dir / "api_keys.json").write_text(json.dumps({"OPENAI_API_KEY": ""}))
        imported = self.root / "import.json"
        imported.write_text(json.dumps({"OPENAI_API_KEY": "filled"}))
        seed_secrets(self.root, non_interactive=True, import_path=imported)
        self.assertEqual(
            json.loads((secret_dir / "api_keys.json").read_text())["OPENAI_API_KEY"],
            "filled",
        )
        with self.assertRaises(ValueError):
            seed_secrets(
                self.root, non_interactive=True, import_path=self.root / "missing.json"
            )

    def test_concurrent_imports_preserve_both_keys(self):
        seed_secrets(self.root, non_interactive=True)
        imports = []
        for key, value in (("OPENAI_API_KEY", "one"), ("GEMINI_API_KEY", "two")):
            path = self.root / f"{key}.json"
            path.write_text(json.dumps({key: value}))
            imports.append(path)
        errors = []

        def run(path):
            try:
                seed_secrets(self.root, non_interactive=True, import_path=path)
            except (OSError, ValueError) as exc:  # pragma: no cover - diagnostic
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(path,)) for path in imports]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(
            json.loads((self.root / "secrets/api_keys.json").read_text()),
            {"OPENAI_API_KEY": "one", "GEMINI_API_KEY": "two"},
        )

    def test_malformed_existing_file_does_not_seed_credentials(self):
        secret_dir = self.root / "secrets"
        secret_dir.mkdir()
        keys = secret_dir / "api_keys.json"
        keys.write_text("[]")
        with self.assertRaises(ValueError):
            seed_secrets(self.root, non_interactive=True)
        self.assertEqual(list(secret_dir.iterdir()), [keys])
        self.assertEqual(keys.read_text(), "[]")

    def test_interactive_uses_hidden_prompts_and_does_not_rotate_blank_existing(self):
        secret_dir = self.root / "secrets"
        secret_dir.mkdir()
        (secret_dir / "api_keys.json").write_text(json.dumps({"OPENAI_API_KEY": ""}))
        with mock.patch(
            "scripts.seed_secrets.getpass.getpass", return_value="  "
        ) as prompt:
            seed_secrets(self.root)
        self.assertTrue(prompt.called)
        self.assertEqual(
            json.loads((secret_dir / "api_keys.json").read_text()),
            {"OPENAI_API_KEY": ""},
        )

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_symlink_secret_refused(self):
        secret_dir = self.root / "secrets"
        secret_dir.mkdir()
        target = self.root / "outside"
        target.write_text("untouched")
        (secret_dir / "db_password.txt").symlink_to(target)
        with self.assertRaises(ValueError):
            seed_secrets(self.root, non_interactive=True)
        self.assertEqual(target.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
