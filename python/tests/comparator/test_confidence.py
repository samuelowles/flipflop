"""Tests for confidence scoring."""
from comparator.confidence import compute_confidence, compute_comparison_confidence


class TestComputeConfidence:
    def test_perfect_confidence(self):
        # 12+ bills, 0 days old, all fields complete
        score = compute_confidence(12, 0, 11, 11)
        assert score == 1.0

    def test_zero_bills_zero_confidence(self):
        score = compute_confidence(0, 0, 0, 11)
        assert score >= 0.0
        assert score < 0.5  # Bill factor is 0, so max 0.6 from others

    def test_six_bills_mid_confidence(self):
        score = compute_confidence(6, 45, 6, 11)
        assert 0.3 <= score <= 0.7

    def test_old_bills_reduce_confidence(self):
        fresh = compute_confidence(6, 0, 11, 11)
        old = compute_confidence(6, 90, 11, 11)
        assert old < fresh

    def test_partial_fields_reduce_confidence(self):
        complete = compute_confidence(6, 0, 11, 11)
        partial = compute_confidence(6, 0, 5, 11)
        assert partial < complete

    def test_maxes_out_at_one(self):
        score = compute_confidence(20, 0, 20, 11)
        assert score == 1.0

    def test_mins_out_at_zero(self):
        score = compute_confidence(0, 100, 0, 11)
        assert score >= 0.0  # Should be 0 or very close to 0
        assert score < 0.1

    def test_returns_float(self):
        score = compute_confidence(3, 30, 7, 11)
        assert isinstance(score, float)


class TestComputeComparisonConfidence:
    def test_no_bills(self):
        assert compute_comparison_confidence([]) == 0.0

    def test_with_bills(self):
        bills = [
            {
                "total_cents": 12500,
                "usage_kwh": 450.0,
                "c_per_kwh": 25.0,
                "c_per_day": 90.0,
                "period_start": "2026-04-01",
                "period_end": "2026-04-30",
                "days": 30,
                "plan_name": "Standard",
                "meter_type": "standard",
                "icp_number": "0001234567ABC99",
                "retailer": "Contact Energy",
            },
        ]
        score = compute_comparison_confidence(bills)
        assert 0.0 < score < 1.0

    def test_multiple_bills_higher_confidence(self):
        bill = {
            "total_cents": 12500,
            "usage_kwh": 450.0,
            "c_per_kwh": 25.0,
            "c_per_day": 90.0,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
            "days": 31,
            "plan_name": "Standard",
            "meter_type": "standard",
            "icp_number": "0001234567ABC99",
            "retailer": "Contact Energy",
        }
        one_bill_score = compute_comparison_confidence([bill])
        many_bills_score = compute_comparison_confidence([bill] * 6)
        assert many_bills_score > one_bill_score
