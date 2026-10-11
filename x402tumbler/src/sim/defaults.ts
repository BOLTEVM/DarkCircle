/**
 * Deterministic Quai Cyprus-1 addresses used as simulation defaults.
 *
 * Each is a valid zone-0x00, Quai-ledger address produced by grindQuaiKey() from
 * keccak256("darkcircle-sim-<role>"). Their keys are derivable from a public label, so they are
 * for the in-memory ledger only and must never hold real funds.
 */
export const SIM_POOL_ADDRESS = "0x000be6cd2cAc6d3e23020993eA384386A11FDF3C";
/** Pool for WQI. Each asset has its own pool, so notes, custody and anonymity sets are per asset. */
export const SIM_POOL_WQI_ADDRESS = "0x005e97845b74D0D4b6a2680F1bccC4CD00276c2d";
export const SIM_RELAYER_ADDRESS = "0x0024Eb33E0e381844d7f56B748f6Ad8969c3cf79";
export const SIM_OPERATING_ADDRESS = "0x004E3d0a19fA256E0A8903528605dE5acD8Faa72";
export const SIM_DEPOSITOR_ADDRESS = "0x006d1C61069f1A2169DD06Cd2aDad337C05d2Ac3";
export const SIM_MERCHANT_ADDRESS = "0x0054328EF0070FcEeEa0A22bb01FA5f6614098Ef";
export const SIM_VENDOR_ADDRESS = "0x003793E8b9DF52434EB58327453cA84528FBe18d";
