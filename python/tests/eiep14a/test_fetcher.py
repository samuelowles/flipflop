"""Tests for EIEP14A fetcher."""
from unittest.mock import patch, MagicMock

import pytest
from eiep14a.fetcher import fetch_eiep14a_data, fetch_with_retry, _parse_response


class TestFetchEIEP14A:
    @patch("eiep14a.fetcher.requests.get")
    def test_fetches_json_data(self, mock_get):
        mock_response = MagicMock()
        mock_response.headers.get.return_value = "application/json"
        mock_response.text = '[{"Retailer":"Contact Energy","Plan":"Standard"}]'
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        records = fetch_eiep14a_data()

        assert len(records) == 1
        assert records[0]["Retailer"] == "Contact Energy"

    @patch("eiep14a.fetcher.requests.get")
    def test_fetches_csv_data(self, mock_get):
        csv_text = "Retailer,Plan\nContact Energy,Standard\nMercury,Online\n"
        mock_response = MagicMock()
        mock_response.headers.get.return_value = "text/csv"
        mock_response.text = csv_text
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        records = fetch_eiep14a_data()

        assert len(records) == 2
        assert records[0]["Retailer"] == "Contact Energy"
        assert records[1]["Plan"] == "Online"

    @patch("eiep14a.fetcher.requests.get")
    def test_caches_to_file(self, mock_get, tmp_path):
        mock_response = MagicMock()
        mock_response.headers.get.return_value = "application/json"
        mock_response.text = '[{"Retailer":"Test"}]'
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        cache_path = tmp_path / "eiep14a_cache.json"
        records = fetch_eiep14a_data(cache_path=str(cache_path))

        assert cache_path.exists()
        content = cache_path.read_text()
        assert "Test" in content
        assert len(records) == 1

    @patch("eiep14a.fetcher.requests.get")
    def test_raises_on_http_error(self, mock_get):
        import requests as req

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = req.HTTPError("500 Server Error")
        mock_get.return_value = mock_response

        with pytest.raises(req.HTTPError):
            fetch_eiep14a_data()


class TestParseResponse:
    def test_parses_json_list(self):
        records = _parse_response('[{"a": 1}, {"a": 2}]', "application/json")
        assert len(records) == 2
        assert records[0]["a"] == 1

    def test_parses_json_dict_with_records(self):
        records = _parse_response('{"records": [{"a": 1}]}', "application/json")
        assert len(records) == 1
        assert records[0]["a"] == 1

    def test_parses_json_dict_with_items(self):
        records = _parse_response('{"items": [{"b": 2}]}', "application/json")
        assert len(records) == 1
        assert records[0]["b"] == 2

    def test_parses_single_json_dict(self):
        records = _parse_response('{"single": "value"}', "application/json")
        assert len(records) == 1
        assert records[0]["single"] == "value"

    def test_parses_csv(self):
        records = _parse_response("col1,col2\na,1\nb,2\n", "text/csv")
        assert len(records) == 2
        assert records[0]["col1"] == "a"

    def test_raises_on_empty(self):
        with pytest.raises(ValueError, match="empty"):
            _parse_response("", "")


class TestFetchWithRetry:
    @patch("eiep14a.fetcher.fetch_eiep14a_data")
    def test_retries_on_failure(self, mock_fetch):
        import requests as req

        mock_fetch.side_effect = [
            req.ConnectionError("first"),
            req.ConnectionError("second"),
            [{"id": 1}],
        ]

        records = fetch_with_retry(max_retries=3)
        assert len(records) == 1
        assert records[0]["id"] == 1
        assert mock_fetch.call_count == 3
