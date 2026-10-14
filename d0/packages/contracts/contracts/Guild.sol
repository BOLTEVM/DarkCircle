// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * DarkOrder guild core: the on-chain body of one guild. Inspired by the Aragon OSx DAO:
 * a permission manager gates every sensitive entry point, and the only way value or calls
 * leave the guild is `execute`, which only addresses holding EXECUTE_ROLE (the governance
 * modules) may call. The guild always holds every permission over itself, so a passed
 * proposal can reconfigure anything: grant a new module, rotate the council, move treasury.
 *
 * Treasury: the contract receives native QUAI (`receive`, or `payTribute` with an x402
 * invoice id so a paid service can match the receipt to its invoice). Spending the
 * treasury is always a proposal action, never a direct call.
 */
contract Guild {
    struct Action {
        address to;
        uint256 value;
        bytes data;
    }

    bytes32 public constant ROOT_ROLE = keccak256("ROOT_ROLE");
    bytes32 public constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 public constant SET_METADATA_ROLE = keccak256("SET_METADATA_ROLE");

    mapping(bytes32 => mapping(address => bool)) private _permissions;

    string public metadata;

    event Granted(bytes32 indexed role, address indexed who);
    event Revoked(bytes32 indexed role, address indexed who);
    event Executed(address indexed actor, uint256 actionCount);
    event MetadataSet(string metadata);
    event TributeReceived(address indexed from, uint256 amount, bytes32 indexed invoiceId);

    error AlreadyGranted(bytes32 role, address who);
    error NotGranted(bytes32 role, address who);
    error Unauthorized(bytes32 role, address who);
    error ActionFailed(uint256 index);

    modifier auth(bytes32 role) {
        if (!hasPermission(role, msg.sender)) revert Unauthorized(role, msg.sender);
        _;
    }

    /// @param root The first ROOT holder. The founding factory uses it to wire the guild,
    ///             then revokes itself; a guild founded any other way is not a DarkOrder guild.
    constructor(address root) {
        if (root == address(0)) revert Unauthorized(ROOT_ROLE, address(0));
        _permissions[ROOT_ROLE][root] = true;
        emit Granted(ROOT_ROLE, root);
    }

    /// The guild contract itself holds every permission implicitly: proposals executed
    /// through `execute` act as the guild and may therefore reconfigure anything.
    function hasPermission(bytes32 role, address who) public view returns (bool) {
        return _permissions[role][who] || who == address(this);
    }

    function grant(bytes32 role, address who) external auth(ROOT_ROLE) {
        if (hasPermission(role, who)) revert AlreadyGranted(role, who);
        _permissions[role][who] = true;
        emit Granted(role, who);
    }

    function revoke(bytes32 role, address who) external auth(ROOT_ROLE) {
        if (!_permissions[role][who]) revert NotGranted(role, who);
        _permissions[role][who] = false;
        emit Revoked(role, who);
    }

    /// Runs an ordered batch of calls as the guild. The whole batch reverts if one action
    /// fails, so a proposal is all-or-nothing.
    function execute(Action[] calldata actions) external payable auth(EXECUTE_ROLE) returns (bytes[] memory results) {
        results = new bytes[](actions.length);
        for (uint256 i = 0; i < actions.length; ++i) {
            (bool ok, bytes memory out) = actions[i].to.call{value: actions[i].value}(actions[i].data);
            if (!ok) revert ActionFailed(i);
            results[i] = out;
        }
        emit Executed(msg.sender, actions.length);
    }

    function setMetadata(string calldata newMetadata) external auth(SET_METADATA_ROLE) {
        metadata = newMetadata;
        emit MetadataSet(newMetadata);
    }

    /// x402 tribute: pays the treasury with an invoice id attached, so the paid service can
    /// match this payment to its invoice from the receipt log.
    function payTribute(bytes32 invoiceId) external payable {
        emit TributeReceived(msg.sender, msg.value, invoiceId);
    }

    receive() external payable {
        emit TributeReceived(msg.sender, msg.value, bytes32(0));
    }
}
