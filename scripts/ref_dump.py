"""Run the Python reference extractor (blend-viewer-handoff/reference/extract.py) on .blend files
and print the results as one JSON object keyed by file path. Used by test/crosscheck.test.ts.
Needs numpy and zstandard."""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', 'blend-viewer-handoff', 'reference'))
from extract import extract  # noqa: E402

out = {}
for f in sys.argv[1:]:
    try:
        out[f] = extract(f)
    except Exception as e:  # the reference has no error handling; record and move on
        out[f] = {'_error': repr(e)}
json.dump(out, sys.stdout, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o))
