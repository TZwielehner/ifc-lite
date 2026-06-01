/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  ColumnarParser,
  type IfcDataStore,
  type SourceReader,
  extractEntityAttributesOnDemand,
} from '../src/columnar-parser.js';
import { scanEntitiesChunked } from '../src/chunked-tokenizer.js';
import type { EntityRef } from '../src/types.js';

const enc = new TextEncoder();

/**
 * Tiny SourceReader that forces the NON-Uint8Array code path. It delegates to a
 * backing Uint8Array but is deliberately NOT a Uint8Array instance, so:
 *   - `batchExtractGlobalIdAndName` takes its per-entity fallback,
 *   - `scanEntitiesChunked` reads through `subarray` in small windows,
 *   - `EntityExtractor` reads each entity via a fresh range read.
 * Every `subarray` returns a COPY so the consumer can never accidentally rely
 * on the slice aliasing the full buffer at a nonzero offset (mimics a disk read).
 */
class WindowedSourceReader implements SourceReader {
  readonly byteLength: number;
  constructor(private readonly backing: Uint8Array) {
    this.byteLength = backing.byteLength;
  }
  subarray(start: number, end: number): Uint8Array {
    return this.backing.slice(start, end);
  }
}

// Multi-entity IFC fixture: header, spatial entities (project/site/building/
// storey), a containment rel, a property set + its IfcRelDefinesByProperties,
// plus GlobalId+Name on the products. Mirrors chunked-tokenizer.test.ts style.
function buildFixture(): Uint8Array {
  const text =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('ViewDefinition'),'2;1');\n` +
    `FILE_SCHEMA(('IFC4'));\n` +
    `ENDSEC;\n` +
    `DATA;\n` +
    `#1=IFCPROJECT('0Project00000000000001',#2,'My Project',$,$,$,$,(#11),#12);\n` +
    `#2=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,1234);\n` +
    `#5=IFCSITE('0Site0000000000000001',#2,'Site A',$,$,$,$,$,$,$,$,$,$,$);\n` +
    `#6=IFCBUILDING('0Building000000000001',#2,'Building B',$,$,$,$,$,$,$,$,$);\n` +
    `#7=IFCBUILDINGSTOREY('0Storey00000000000001',#2,'Level 1',$,$,$,$,$,.ELEMENT.,3000.0);\n` +
    `#10=IFCWALL('0Wall00000000000000001',#2,'Wall with '' quote and (parens)',$,$,$,$,$);\n` +
    `#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#13,$);\n` +
    `#12=IFCUNITASSIGNMENT((#14));\n` +
    `#13=IFCAXIS2PLACEMENT3D(#15,$,$);\n` +
    `#14=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n` +
    `#15=IFCCARTESIANPOINT((0.0,0.0,0.0));\n` +
    `#20=IFCRELAGGREGATES('0Agg000000000000000001',#2,$,$,#1,(#5));\n` +
    `#21=IFCRELAGGREGATES('0Agg000000000000000002',#2,$,$,#5,(#6));\n` +
    `#22=IFCRELAGGREGATES('0Agg000000000000000003',#2,$,$,#6,(#7));\n` +
    `#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont00000000000000001',#2,$,$,(#10),#7);\n` +
    `#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 60'),$);\n` +
    `#31=IFCPROPERTYSET('0Pset00000000000000001',#2,'Pset_WallCommon',$,(#30));\n` +
    `#32=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000001',#2,$,$,(#10),#31);\n` +
    `ENDSEC;\n` +
    `END-ISO-10303-21;\n`;
  return enc.encode(text);
}

function scanRefs(source: SourceReader): EntityRef[] {
  const refs: EntityRef[] = [];
  // Small window to force cross-window straddling in the chunked scanner.
  for (const e of scanEntitiesChunked(source, 7)) {
    refs.push({
      expressId: e.expressId,
      type: e.type,
      byteOffset: e.offset,
      byteLength: e.length,
      lineNumber: e.line,
    });
  }
  return refs;
}

describe('SourceReader parse path == contiguous path', () => {
  const fixture = buildFixture();

  it('produces an identical store via the windowed SourceReader path', async () => {
    // (a) contiguous in-memory parse: scan over the raw Uint8Array (which IS a
    // Uint8Array, so parseLite takes the batched-decode fast path) and parse
    // with NO sourceReader, so the store materializes `buffer` internally.
    const buffer = fixture.buffer.slice(
      fixture.byteOffset,
      fixture.byteOffset + fixture.byteLength,
    ) as ArrayBuffer;
    const contiguousRefs = scanRefs(fixture);
    const contiguous: IfcDataStore = await new ColumnarParser().parseLite(
      buffer,
      contiguousRefs,
      {},
    );

    // (b) SourceReader path: chunked scan + parseLite with sourceReader=wrapper.
    // The wrapper is NOT a Uint8Array, so this exercises the OPFS code path.
    const reader = new WindowedSourceReader(fixture);
    const refs = scanRefs(reader);
    const viaReader: IfcDataStore = await new ColumnarParser().parseLite(
      new ArrayBuffer(0),
      refs,
      { sourceReader: reader },
    );

    // entityCount identical
    expect(viaReader.entityCount).toBe(contiguous.entityCount);

    // byId key sets identical
    const idsA = [...contiguous.entityIndex.byId.keys()].sort((x, y) => x - y);
    const idsB = [...viaReader.entityIndex.byId.keys()].sort((x, y) => x - y);
    expect(idsB).toEqual(idsA);

    // byType identical (keys + sorted id lists)
    const typeKeysA = [...contiguous.entityIndex.byType.keys()].sort();
    const typeKeysB = [...viaReader.entityIndex.byType.keys()].sort();
    expect(typeKeysB).toEqual(typeKeysA);
    for (const key of typeKeysA) {
      const a = [...(contiguous.entityIndex.byType.get(key) ?? [])].sort((x, y) => x - y);
      const b = [...(viaReader.entityIndex.byType.get(key) ?? [])].sort((x, y) => x - y);
      expect(b).toEqual(a);
    }

    // schema + unit scale identical (unit-extractor through the seam)
    expect(viaReader.schemaVersion).toBe(contiguous.schemaVersion);
    expect(viaReader.lengthUnitScale).toBe(contiguous.lengthUnitScale);

    // On-demand extraction byte-identical for known entities (GlobalId+Name).
    for (const id of [1, 5, 6, 7, 10]) {
      const a = extractEntityAttributesOnDemand(contiguous, id);
      const b = extractEntityAttributesOnDemand(viaReader, id);
      expect(b).toEqual(a);
    }

    // Spot-check the IfcWall name survived the '' escape + parens identically.
    const wallA = extractEntityAttributesOnDemand(contiguous, 10);
    expect(wallA.name).toBe("Wall with ' quote and (parens)");
  });

  it('chunked scan over the wrapper matches a real Uint8Array scan', () => {
    const reader = new WindowedSourceReader(fixture);
    const viaReader = scanRefs(reader);
    const viaBytes = scanRefs(fixture); // Uint8Array also satisfies SourceReader
    expect(viaReader).toEqual(viaBytes);
  });
});
