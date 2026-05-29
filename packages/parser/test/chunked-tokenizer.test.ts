/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { scanEntitiesChunked, type ScannedEntity } from '../src/chunked-tokenizer.js';

const enc = new TextEncoder();

// A fixture exercising the cross-window hazards: a HEADER section with no
// entities, simple + multi-line entities, quoted strings containing the
// delimiters that drive the scanner (',', '(', ')', ';'), STEP doubled-quote
// escapes (''), inner #refs inside bodies (must NOT be mistaken for entity
// starts), varied whitespace around '=' and the type name, and one large
// entity (a long coordinate list) bigger than the small test windows.
function buildFixture(): Uint8Array {
  const bigCoords = Array.from({ length: 400 }, (_, i) => `(${i}.0,${i}.5,0.0)`).join(',');
  const text =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('a;b(c)'),'2;1');\n` +
    `ENDSEC;\n` +
    `DATA;\n` +
    `#1=IFCPROJECT('0Yvctef',#2,'Proj',$,$,$,$,(#11),#7);\n` +
    `#2 = IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,1234);\n` +
    `#10=IFCWALL('it has a ; and a '' quote and (parens)',$,$,$);\n` +
    `#11=IFCPROPERTYSINGLEVALUE(\n` +
    `  'Multi\n` +
    `  Line',$,IFCLABEL('x,y;z'),$);\n` +
    `#12=IFCCARTESIANPOINTLIST3D((${bigCoords}));\n` +
    `#13=IFCRELAGGREGATES('g',#2,$,$,#1,(#10,#11));\n` +
    `ENDSEC;\n` +
    `END-ISO-10303-21;\n`;
  return enc.encode(text);
}

function fastScan(buf: Uint8Array): ScannedEntity[] {
  const out: ScannedEntity[] = [];
  for (const e of new StepTokenizer(buf).scanEntitiesFast()) {
    out.push({ expressId: e.expressId, type: e.type, offset: e.offset, length: e.length, line: e.line });
  }
  return out;
}

describe('scanEntitiesChunked', () => {
  const fixture = buildFixture();
  const reference = fastScan(fixture);

  it('reference scan finds the expected entities', () => {
    expect(reference.map((e) => e.expressId)).toEqual([1, 2, 10, 11, 12, 13]);
    // Round-trip: every reported [offset,length] slice starts with '#id='.
    for (const e of reference) {
      const slice = fixture.subarray(e.offset, e.offset + e.length);
      expect(new TextDecoder().decode(slice)).toMatch(new RegExp(`^#${e.expressId}\\s*=`));
      expect(slice[slice.length - 1]).toBe(0x3b); // ends with ';'
    }
  });

  // The core guarantee: identical output at every window size, including
  // pathologically small ones that split entities, tokens, strings, and
  // escaped quotes across the boundary.
  for (const win of [1, 2, 3, 4, 5, 7, 11, 13, 16, 29, 64, 256, 1024, 4096, 1 << 20]) {
    it(`matches scanEntitiesFast at windowBytes=${win}`, () => {
      const chunked = [...scanEntitiesChunked(fixture, win)];
      expect(chunked).toEqual(reference);
    });
  }

  it('handles an empty source', () => {
    expect([...scanEntitiesChunked(enc.encode(''), 8)]).toEqual([]);
  });

  it('handles a single entity smaller than the window', () => {
    const buf = enc.encode('#1=IFCWALL($);\n');
    expect([...scanEntitiesChunked(buf, 4096)]).toEqual(fastScan(buf));
  });

  it('grows past windowBytes for an entity larger than a single window', () => {
    // Window of 8 bytes; the entity body is hundreds of bytes → forces repeated
    // growth before the ';' is reached.
    const body = Array.from({ length: 200 }, (_, i) => `#${i + 100}`).join(',');
    const buf = enc.encode(`#1=IFCRELAGGREGATES(${body});\n`);
    expect([...scanEntitiesChunked(buf, 8)]).toEqual(fastScan(buf));
  });
});
