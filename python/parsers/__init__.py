"""
Flip bill parser package.

Retailer-specific parsers are imported here so their ``register_parser()``
calls populate ``_PARSER_REGISTRY`` at startup.  The generic parser is always
available as a fallback.
"""

from parsers.contact_parser import ContactParser
from parsers.electric_kiwi_parser import ElectricKiwiParser
from parsers.flick_parser import FlickParser
from parsers.genesis_parser import GenesisParser
from parsers.meridian_parser import MeridianParser
from parsers.mercury_parser import MercuryParser
from parsers.nova_parser import NovaParser
from parsers.powershop_parser import PowershopParser
from parsers.pulse_parser import PulseParser
from parsers.trustpower_parser import TrustpowerParser

__all__ = [
    "ContactParser",
    "ElectricKiwiParser",
    "FlickParser",
    "GenesisParser",
    "MeridianParser",
    "MercuryParser",
    "NovaParser",
    "PowershopParser",
    "PulseParser",
    "TrustpowerParser",
]
