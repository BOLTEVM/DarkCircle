import { time } from "@nomicfoundation/hardhat-network-helpers";

export const E18 = 10n ** 18n;
export const DAY = 86_400n;
export const SEED = 1_000_000_000_000n;
export const deadline = async (seconds = 3600) => (await time.latest()) + seconds;
