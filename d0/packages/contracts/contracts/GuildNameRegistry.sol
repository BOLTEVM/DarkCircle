// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The on-chain directory of the Grand Guild Halls: handle -> guild record, written once
 * at founding by the factory and never overwritten. This is the enumerable registry the
 * Halls page reads; it is deliberately not a naming service. A guild's public identity
 * (its `.quai` name, profile and avatar) lives in QNS, the Quai Name Service; this
 * handle exists so the halls can be listed on-chain and so a guild can be found by a
 * short name without trusting an off-chain index.
 *
 * Handles: 1-64 chars, lowercase a-z 0-9 hyphen underscore, matching the QNS charset.
 */
contract GuildNameRegistry {
    struct GuildRecord {
        string name;
        address guild;
        address token; // zero for council guilds
        address module; // MajorityVoting or CouncilMultisig
        uint8 mode; // 0 = token, 1 = council
    }

    address private immutable _deployer;
    address public factory;

    mapping(bytes32 => address) private _guilds;
    mapping(address => GuildRecord) private _records;
    string[] private _names;

    event GuildRegistered(string name, address indexed guild, address token, address module, uint8 mode);
    event Wired(address indexed factory);

    error NotFactory(address caller);
    error NotDeployer(address caller);
    error AlreadyWired();
    error FactoryZero();
    error NameTaken(string name);
    error NameInvalid(string name);
    error GuildZero();

    constructor() {
        _deployer = msg.sender;
    }

    /**
     * One-time wiring to the factory. The pair cannot be constructor-bound: on Quai a
     * CREATE address depends on the init data, so a registry that names the factory in
     * its constructor and a factory that names the registry in its own could never be
     * ground into Cyprus-1 simultaneously. The deployer wires once, immediately after
     * both creations, before any guild exists to be impersonated.
     */
    function wire(address factory_) external {
        if (msg.sender != _deployer) revert NotDeployer(msg.sender);
        if (factory != address(0)) revert AlreadyWired();
        if (factory_ == address(0)) revert FactoryZero();
        factory = factory_;
        emit Wired(factory_);
    }

    function register(string calldata name, address guild, address token, address module, uint8 mode) external {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (guild == address(0)) revert GuildZero();
        _validate(name);
        bytes32 h = keccak256(bytes(name));
        if (_guilds[h] != address(0)) revert NameTaken(name);
        _guilds[h] = guild;
        _records[guild] = GuildRecord(name, guild, token, module, mode);
        _names.push(name);
        emit GuildRegistered(name, guild, token, module, mode);
    }

    function resolve(string calldata name) external view returns (address) {
        return _guilds[keccak256(bytes(name))];
    }

    function recordOf(address guild) external view returns (GuildRecord memory) {
        return _records[guild];
    }

    function count() external view returns (uint256) {
        return _names.length;
    }

    function nameAt(uint256 index) external view returns (string memory) {
        return _names[index];
    }

    /// One directory page of full records, so the UI never loops over unbounded storage.
    function page(uint256 offset, uint256 limit) external view returns (GuildRecord[] memory out) {
        uint256 total = _names.length;
        if (offset >= total) return new GuildRecord[](0);
        uint256 n = total - offset;
        if (n > limit) n = limit;
        out = new GuildRecord[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = _records[_guilds[keccak256(bytes(_names[offset + i]))]];
        }
    }

    function _validate(string memory name) internal pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 64) revert NameInvalid(name);
        for (uint256 i = 0; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F;
            if (!ok) revert NameInvalid(name);
        }
    }
}
