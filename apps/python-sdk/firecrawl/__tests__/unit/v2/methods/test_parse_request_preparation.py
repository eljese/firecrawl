import json
import pytest

from firecrawl.v2.types import ScrapeOptions
from firecrawl.v2.methods.parse import _prepare_parse_request


class TestParseRequestPreparation:
    def test_prepare_parse_request_from_bytes(self):
        options = ScrapeOptions(
            formats=["markdown"],
            only_main_content=False,
            integration="  parse-unit  ",
        )

        fields, files = _prepare_parse_request(
            b"<html><body><h1>Parse</h1></body></html>",
            options,
            filename="upload.html",
            content_type="text/html",
        )

        assert "options" in fields
        payload = json.loads(fields["options"])
        assert payload["formats"] == ["markdown"]
        assert payload["onlyMainContent"] is False
        assert payload["integration"] == "parse-unit"
        assert payload["origin"].startswith("python-sdk@")

        assert "file" in files
        filename, file_bytes, mime_type = files["file"]
        assert filename == "upload.html"
        assert file_bytes.startswith(b"<html>")
        assert mime_type == "text/html"

    def test_prepare_parse_request_from_file_path(self, tmp_path):
        file_path = tmp_path / "sample.html"
        file_path.write_text("<html><body>Path Upload</body></html>")

        fields, files = _prepare_parse_request(str(file_path))

        payload = json.loads(fields["options"])
        assert payload["origin"].startswith("python-sdk@")
        assert payload.get("formats") is None

        filename, file_bytes, mime_type = files["file"]
        assert filename == "sample.html"
        assert b"Path Upload" in file_bytes
        assert mime_type == "text/html"

    def test_prepare_parse_request_rejects_missing_path(self):
        with pytest.raises(ValueError, match="File path does not exist"):
            _prepare_parse_request("/tmp/does-not-exist-upload-file.html")
