#!/usr/bin/env python3
"""Cross-check Kestrel against FlowKit (https://github.com/whitews/FlowKit).

Evaluates a Gating-ML 2.0 file on one FCS file with FlowKit and with Kestrel's
engine, and compares the event count of every gate.

    pip install flowkit
    npm run demo-data                       # or use your own files
    python3 scripts/flowkit-crosscheck.py demo-data/PBMC_Donor01.fcs examples/pbmc-7colour.gating-ml.xml
"""
import json
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

import flowkit as fk


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    fcs, xml = sys.argv[1], sys.argv[2]
    root = pathlib.Path(__file__).resolve().parent.parent

    sample = fk.Sample(fcs)
    strategy = fk.parse_gating_xml(xml)
    report = strategy.gate_sample(sample).report
    flowkit_counts = {}
    for _, row in report.iterrows():
        flowkit_counts[row["gate_name"]] = int(row["count"])

    kestrel = subprocess.run(
        ["node", str(root / "scripts" / "gatingml-counts.mjs"), fcs, xml],
        check=True, capture_output=True, text=True,
    )
    kestrel_counts = json.loads(kestrel.stdout)

    # FlowKit reports Gating-ML ids; Kestrel reports the names kept in custom_info.
    id_to_name = {}
    for el in ET.parse(xml).getroot():
        gid = next((v for k, v in el.attrib.items() if k.endswith("}id")), None)
        name = next((n.text for n in el.iter() if n.tag == "name"), None)
        if gid:
            id_to_name[gid] = name or gid
    same = 0
    print(f"{'gate':32} {'FlowKit':>9} {'Kestrel':>9}")
    for gid, n_fk in flowkit_counts.items():
        name = id_to_name.get(gid, gid)
        n_lm = kestrel_counts.get(name)
        ok = n_lm == n_fk
        same += ok
        print(f"{name[:32]:32} {n_fk:9d} {n_lm if n_lm is not None else '-':>9} {'' if ok else '  <- differs'}")
    print(f"\n{same} of {len(flowkit_counts)} gates have identical counts (FlowKit {fk.__version__}).")
    sys.exit(0 if same == len(flowkit_counts) else 1)


if __name__ == "__main__":
    main()
