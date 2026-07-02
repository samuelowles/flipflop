"""
Flip Python HTTP server.

Exposes the bill parser and plan comparator as HTTP endpoints for
the Cloudflare Worker to invoke.

Routes:
  POST /parse    — Parse a bill PDF, returns ParserResult JSON
  POST /compare  — Compare plans, returns ranked comparison JSON
  GET  /health   — Health check
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
from typing import Optional

from flask import Flask, jsonify, request

from parsers.base import parser_for_retailer, ParserResult
from parsers.generic_parser import GenericParser
from comparator.plan_comparator import compare

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = Flask(__name__)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("flip.server")

SERVICE_AUTH_TOKEN = os.environ.get("SERVICE_AUTH_TOKEN", "")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _check_auth() -> Optional[tuple]:
    """Validate Bearer token if SERVICE_AUTH_TOKEN is configured.

    Returns None if auth is valid, or a (error_json, status_code) tuple if not.
    """
    if not SERVICE_AUTH_TOKEN:
        return None  # Auth not configured — allow all requests

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "Missing or invalid Authorization header"}), 401

    token = auth_header[len("Bearer "):]
    if token != SERVICE_AUTH_TOKEN:
        return jsonify({"error": "Invalid service token"}), 403

    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "service": "flip-python",
    })


@app.route("/parse", methods=["POST"])
def parse_bill():
    """Parse a bill PDF and return structured data.

    Request body (new): ``{"file_bytes": "<base64-pdf>", "retailer_id": str}``
    Request body (legacy): ``{"file_path": str, "retailer_id": str}``
    Response: ParserResult as JSON
    """
    tmp_path: Optional[str] = None

    try:
        auth_result = _check_auth()
        if auth_result:
            return auth_result

        body = request.get_json(silent=True)
        if not body:
            return jsonify({"error": "Request body must be JSON"}), 400

        file_path = body.get("file_path", "")
        file_bytes_b64 = body.get("file_bytes", "")
        retailer_id = body.get("retailer_id", "")

        if not file_path and not file_bytes_b64:
            return jsonify(
                {"error": "Either file_path or file_bytes is required"}
            ), 400

        # --- New path: base64-encoded file bytes ---
        if file_bytes_b64:
            try:
                file_bytes = base64.b64decode(file_bytes_b64)
            except Exception:
                return jsonify(
                    {"error": "Invalid base64 encoding in file_bytes"}
                ), 400

            tmp_file = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
            tmp_file.write(file_bytes)
            tmp_file.close()
            tmp_path = tmp_file.name
            file_path = tmp_path

        # --- Legacy path: verify file exists on disk ---
        elif not os.path.isfile(file_path):
            return jsonify({"error": f"File not found: {file_path}"}), 404

        # Select parser
        parser = parser_for_retailer(retailer_id) if retailer_id else None
        used_generic = parser is None
        if used_generic:
            logger.info(
                "No retailer-specific parser for '%s', using generic", retailer_id
            )
            parser = GenericParser()

        result = parser.parse(file_path)
        parser_name = "generic" if used_generic else (retailer_id or "generic")

        # Retry once with the generic fallback when the primary parser's
        # confidence is below the 0.7 threshold (AI_RULES Bill Parsing
        # Thresholds). Only retries if the primary was NOT already generic.
        if result.confidence < 0.7 and not used_generic:
            fallback = GenericParser()
            fallback_result = fallback.parse(file_path)
            logger.debug(
                "Primary parser '%s' confidence %.3f < 0.7; "
                "generic fallback confidence %.3f",
                parser_name, result.confidence, fallback_result.confidence,
            )
            if fallback_result.confidence > result.confidence:
                result = fallback_result
                parser_name = "generic"

        result.parser_used = parser_name
        return app.response_class(
            response=result.to_json(),
            status=200,
            mimetype="application/json",
        )

    except ValueError as exc:
        logger.warning("Parse validation error: %s", exc)
        return jsonify({"error": str(exc)}), 422
    except Exception as exc:
        logger.error("Parse error: %s", exc, exc_info=True)
        return jsonify({"error": "Internal parse error", "detail": str(exc)}), 500
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.route("/compare", methods=["POST"])
def compare_plans():
    """Compare available plans and return ranked results.

    Request body:
        ``{"usage_profile": dict, "current_plan": dict,
           "available_plans": list[dict], "bill_history": list[dict]}``
    Response: list of comparison dicts (ranked)
    """
    try:
        auth_result = _check_auth()
        if auth_result:
            return auth_result

        body = request.get_json(silent=True)
        if not body:
            return jsonify({"error": "Request body must be JSON"}), 400

        usage_profile = body.get("usage_profile", {})
        current_plan = body.get("current_plan", {})
        available_plans = body.get("available_plans", [])
        bill_history = body.get("bill_history", [])

        if not current_plan:
            return jsonify({"error": "current_plan is required"}), 400
        if not available_plans:
            return jsonify({"error": "available_plans is required"}), 400

        results = compare(
            usage_profile=usage_profile,
            current_plan=current_plan,
            available_plans=available_plans,
            bill_history=bill_history,
        )

        return jsonify(results)

    except Exception as exc:
        logger.error("Compare error: %s", exc, exc_info=True)
        return jsonify({"error": "Internal compare error", "detail": str(exc)}), 500


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify({"error": "Method not allowed"}), 405


@app.errorhandler(500)
def internal_error(_error):
    return jsonify({"error": "Internal server error"}), 500


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
