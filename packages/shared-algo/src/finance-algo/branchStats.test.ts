import { describe, expect, test } from "bun:test";

import {
	BRANCH_STATS,
	DEFAULT_BRANCH_STAT,
	expectedRPerDay,
	getBranchStat,
	MIN_BRANCH_STAT_N,
	registerBranchStats,
} from "./branchStats";

describe("branchStats registry", () => {
	test("ships empty — stats are registration-only", () => {
		expect(Object.keys(BRANCH_STATS)).toHaveLength(0);
	});

	test("registered stats drive getBranchStat", () => {
		registerBranchStats({
			"📈 Synthetic Branch Alpha": {
				n: 150,
				winProb: 0.55,
				avgR: 0.3,
				avgHoldDays: 10,
			},
		});
		expect(getBranchStat("📈 Synthetic Branch Alpha")).toEqual({
			n: 150,
			winProb: 0.55,
			avgR: 0.3,
			avgHoldDays: 10,
		});
	});

	test("below MIN_BRANCH_STAT_N the neutral prior wins", () => {
		expect(MIN_BRANCH_STAT_N).toBe(100);
		registerBranchStats({
			"📉 Synthetic Tiny Sample": {
				n: 70,
				winProb: 0.9,
				avgR: 2,
				avgHoldDays: 5,
			},
		});
		expect(getBranchStat("📉 Synthetic Tiny Sample")).toEqual(
			DEFAULT_BRANCH_STAT,
		);
	});

	test("unknown and missing branch names use the prior", () => {
		expect(getBranchStat("📈 Never Registered")).toEqual(DEFAULT_BRANCH_STAT);
		expect(getBranchStat(undefined)).toEqual(DEFAULT_BRANCH_STAT);
	});

	test("expectedRPerDay is probability-weighted with stats, naive R/day without", () => {
		// 0.55 × 3R − 0.45 × 1R = 1.2 EV per trade → / 10d = 0.12 R/day.
		expect(expectedRPerDay("📈 Synthetic Branch Alpha", 3, 10)).toBe(0.12);
		// No data → naive rrRatio / days.
		expect(expectedRPerDay("📈 Never Registered", 3.5, 10)).toBe(0.35);
		expect(expectedRPerDay(undefined, 3.5, 10)).toBe(0.35);
		// Missing/invalid inputs → undefined (caller falls back).
		expect(expectedRPerDay("📈 Synthetic Branch Alpha", undefined, 10)).toBeUndefined();
		expect(expectedRPerDay("📈 Synthetic Branch Alpha", 3, 0)).toBeUndefined();
	});
});
