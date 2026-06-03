"""
Flip bill parser package.

Retailer-specific parsers are imported here so their ``register_parser()``
calls populate ``_PARSER_REGISTRY`` at startup.  The generic parser is always
available as a fallback.
"""

from parsers.contact_parser import ContactParser
from parsers.genesis_parser import GenesisParser
from parsers.mercury_parser import MercuryParser

__all__ = ["ContactParser", "GenesisParser", "MercuryParser"]
