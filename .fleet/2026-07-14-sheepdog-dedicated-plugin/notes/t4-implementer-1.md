Implemented ordered cooldown detectors: selected adapter intercepts headers/error text first, then strict generic fallback. Ambiguous multi-value Retry-After blocks generic fallback for non-generic adapters; no response-body parsing or fetch interception added.

Added detection self-check covering 429 retry header, strict text indicator+duration rule, and adapter stop-generic result. Verified required command passes.
