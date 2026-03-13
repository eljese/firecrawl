"""
Parse (multipart upload) functionality for Firecrawl v2 API.
"""

import json
import mimetypes
from pathlib import Path
from typing import Optional, Dict, Any, BinaryIO, Union, Tuple

from ..types import ScrapeOptions, Document
from ..utils.normalize import normalize_document_input
from ..utils import HttpClient, handle_response_error, prepare_scrape_options, validate_scrape_options
from ..utils.get_version import get_version

version = get_version()

ParseFileInput = Union[str, bytes, bytearray, Path, BinaryIO]


def _prepare_file_payload(
    file: ParseFileInput,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Dict[str, Tuple[str, bytes, str]]:
    if isinstance(file, (str, Path)):
        file_path = Path(file)
        if not file_path.exists() or not file_path.is_file():
            raise ValueError(f"File path does not exist: {file_path}")
        file_bytes = file_path.read_bytes()
        resolved_filename = filename or file_path.name
    elif isinstance(file, (bytes, bytearray)):
        file_bytes = bytes(file)
        resolved_filename = filename or "upload"
    elif hasattr(file, "read"):
        raw_bytes = file.read()
        if isinstance(raw_bytes, str):
            file_bytes = raw_bytes.encode("utf-8")
        else:
            file_bytes = bytes(raw_bytes)
        guessed_name = getattr(file, "name", None)
        resolved_filename = filename or (Path(guessed_name).name if guessed_name else "upload")
    else:
        raise ValueError("Unsupported file input type. Use a file path, bytes, bytearray, or binary file object.")

    if not resolved_filename or not resolved_filename.strip():
        raise ValueError("filename cannot be empty")

    resolved_filename = resolved_filename.strip()
    resolved_content_type = (
        content_type
        or mimetypes.guess_type(resolved_filename)[0]
        or "application/octet-stream"
    )

    return {
        "file": (resolved_filename, file_bytes, resolved_content_type),
    }


def _prepare_parse_request(
    file: ParseFileInput,
    options: Optional[ScrapeOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Tuple[str, bytes, str]]]:
    request_data: Dict[str, Any] = {}

    if options is not None:
        validated = validate_scrape_options(options)
        if validated is not None:
            opts = prepare_scrape_options(validated)
            if opts:
                request_data.update(opts)

    request_data["origin"] = request_data.get("origin") or f"python-sdk@{version}"
    multipart_fields = {"options": json.dumps(request_data)}
    multipart_files = _prepare_file_payload(
        file,
        filename=filename,
        content_type=content_type,
    )
    return multipart_fields, multipart_files


def parse(
    client: HttpClient,
    file: ParseFileInput,
    options: Optional[ScrapeOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Document:
    fields, files = _prepare_parse_request(
        file,
        options,
        filename=filename,
        content_type=content_type,
    )

    response = client.post_multipart("/v2/parse", data=fields, files=files)
    if not response.ok:
        handle_response_error(response, "parse")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    document_data = body.get("data", {})
    normalized = normalize_document_input(document_data)
    return Document(**normalized)
