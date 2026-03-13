import asyncio
import json
from typing import Optional, Dict, Any, Tuple

from ...types import ScrapeOptions, Document
from ...utils.normalize import normalize_document_input
from ...utils.error_handler import handle_response_error
from ...utils.validation import prepare_scrape_options, validate_scrape_options
from ...utils.http_client_async import AsyncHttpClient
from ...utils.get_version import get_version
from ..parse import ParseFileInput, _prepare_file_payload

version = get_version()

async def _prepare_parse_request(
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
    multipart_files = await asyncio.to_thread(
        _prepare_file_payload,
        file,
        filename,
        content_type,
    )
    return multipart_fields, multipart_files


async def parse(
    client: AsyncHttpClient,
    file: ParseFileInput,
    options: Optional[ScrapeOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Document:
    fields, files = await _prepare_parse_request(
        file,
        options,
        filename=filename,
        content_type=content_type,
    )

    response = await client.post_multipart("/v2/parse", data=fields, files=files)
    if response.status_code >= 400:
        handle_response_error(response, "parse")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    document_data = body.get("data", {})
    normalized = normalize_document_input(document_data)
    return Document(**normalized)
