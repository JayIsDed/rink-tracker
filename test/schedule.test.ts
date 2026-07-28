import { expect, test, describe } from "bun:test";
import { parseSlots, toEpoch, SPACE_TO_RINK } from "../server/jobs/schedule-parse";

// A miniature of the real flight payload: JSON inside JS string literals, one
// level of backslash escaping, nested objects that repeat.
function payload(objs: object[]): string {
  return `<script>self.__next_f.push([1,"${objs
    .map((o) => JSON.stringify(o).replace(/"/g, '\\"'))
    .join(",")}"])</script>`;
}

const iceCut = {
  id: 5501427,
  reservationId: 164485,
  title: "Ice Cut",
  slotType: "maintenance",
  maintenanceTiming: "2",
  startDate: "2026-08-09T00:00:00.000Z",
  startTime: "11:00:00",
  endTime: "11:10:00",
  spaceId: 2553,
  spaceName: "Cromwell Upper Rink - Champions Skating Center ",
};

const freestyle = {
  id: 5501428,
  reservationId: 164486,
  title: "Freestyle Figure Skating",
  slotType: "internal",
  startDate: "2026-08-09T00:00:00.000Z",
  startTime: "11:10:00",
  endTime: "11:40:00",
  spaceId: 2552,
  space: { id: 2552, name: "Cromwell Lower Rink - Champions Skating Center " },
};

const pool = {
  id: 5501429,
  reservationId: 164487,
  title: "Water Aerobics",
  slotType: "external",
  startDate: "2026-08-09T00:00:00.000Z",
  startTime: "09:00:00",
  endTime: "10:00:00",
  spaceId: 9999,
  spaceName: "Pool",
};

describe("parseSlots", () => {
  test("pulls slots out of the escaped flight payload", () => {
    const slots = parseSlots(payload([iceCut, freestyle]));
    expect(slots.length).toBe(2);
    expect(slots.map((s) => s.id).sort()).toEqual([5501427, 5501428]);
    expect(slots.find((s) => s.id === 5501427)!.title).toBe("Ice Cut");
  });

  test("deduplicates repeated slots — children repeat in the payload", () => {
    const slots = parseSlots(payload([iceCut, freestyle, iceCut]));
    expect(slots.length).toBe(2);
  });

  test("survives a nested object without truncating the parent", () => {
    const slots = parseSlots(payload([freestyle]));
    expect(slots[0].spaceId).toBe(2552);
  });

  test("returns nothing for a page with no schedule — the caller treats that as failure", () => {
    expect(parseSlots("<html><body>Loading schedule...</body></html>")).toEqual([]);
  });

  test("ignores chunks that are not slots", () => {
    const junk = `{"id":1,"reservationId":2,"nope":`;
    expect(parseSlots(payload([iceCut]) + junk).length).toBe(1);
  });
});

describe("space → rink mapping", () => {
  test("maps by id, not by name", () => {
    expect(SPACE_TO_RINK[2553]).toBe("U");
    expect(SPACE_TO_RINK[2552]).toBe("L");
  });

  test("non-ice spaces have no rink and get filtered", () => {
    expect(SPACE_TO_RINK[pool.spaceId]).toBeUndefined();
  });
});

describe("toEpoch", () => {
  test("treats the time as LOCAL wall clock, not UTC", () => {
    // 11:00 local on 2026-08-09 (EDT, UTC-4) is 15:00Z. Read as UTC it would be
    // 11:00Z, which is 07:00 local — a four-hour lie on every row.
    const e = toEpoch("2026-08-09T00:00:00.000Z", "11:00:00")!;
    expect(new Date(e).toISOString()).toBe("2026-08-09T15:00:00.000Z");
  });

  test("round-trips back to the same wall clock in the rink's zone", () => {
    for (const t of ["07:30:00", "11:00:00", "13:10:00", "23:45:00"]) {
      const e = toEpoch("2026-08-09T00:00:00.000Z", t)!;
      const back = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(e));
      expect(back).toBe(t.slice(0, 5));
    }
  });

  test("handles standard time as well as daylight time", () => {
    // January is EST (UTC-5).
    const e = toEpoch("2026-01-15T00:00:00.000Z", "07:30:00")!;
    expect(new Date(e).toISOString()).toBe("2026-01-15T12:30:00.000Z");
  });

  test("gets the spring-forward day right", () => {
    // 2026-03-08 is the US DST transition. 07:30 local is EDT (UTC-4).
    const e = toEpoch("2026-03-08T00:00:00.000Z", "07:30:00")!;
    const back = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(e));
    expect(back).toBe("07:30");
  });

  test("gets the fall-back day right", () => {
    const e = toEpoch("2026-11-01T00:00:00.000Z", "07:30:00")!;
    const back = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(e));
    expect(back).toBe("07:30");
  });

  test("refuses garbage rather than returning an epoch near 1970", () => {
    expect(toEpoch("", "")).toBeNull();
    expect(toEpoch("not-a-date", "11:00:00")).toBeNull();
  });
});
