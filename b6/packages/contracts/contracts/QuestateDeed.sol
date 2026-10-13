// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC6065} from "./interfaces/IERC6065.sol";

/**
 * @title QuestateDeed
 * @notice Dark Questate's deed registry: one ERC-721 per verified property title, carrying the
 *         EIP-6065 deed record and its servicing state (lien or credit, foreclosure).
 *
 * Roles:
 *  - The contract owner is the REGISTRAR. It mints a deed only after verifying the title off
 *    chain, and it alone services the debt record and forecloses.
 *  - A deed holder may appoint a property manager. The manager has no power over the debt
 *    record: if it did, a holder could appoint themselves and erase their own lien.
 *  - An appointment ends when the deed changes hands, so a buyer never inherits the seller's
 *    manager. While no manager is appointed, `managerOf` reports the holder.
 */
contract QuestateDeed is ERC721Enumerable, Ownable2Step, IERC6065 {
    struct DeedRecord {
        string legalDescription;
        string physicalAddress;
        string geoJson;
        string parcelId;
        string legalOwner;
        bytes32 operatingAgreementHash;
    }

    struct Servicing {
        address debtToken;
        bool foreclosed;
        int256 debtAmt;
    }

    struct MintParams {
        address recipient;
        string legalDescription;
        string physicalAddress;
        string geoJson;
        string parcelId;
        string legalOwner;
        bytes32 operatingAgreementHash;
        string metadataUri;
    }

    mapping(uint256 => DeedRecord) private _records;
    mapping(uint256 => Servicing) private _servicing;
    mapping(uint256 => address) private _managers;
    mapping(uint256 => string) private _tokenURIs;

    /// @notice keccak256(parcelId) => deed id. One deed per parcel, ever.
    mapping(bytes32 => uint256) public deedIdByParcelHash;

    uint256 private _nextId = 1;

    event DeedMinted(uint256 indexed id, string parcelId, address indexed recipient, string metadataUri);
    event DebtUpdated(uint256 indexed id, address debtToken, int256 debtAmt);
    event ManagerUpdated(uint256 indexed id, address indexed previousManager, address indexed newManager);

    error EmptyField(string field);
    error ParcelAlreadyRegistered(string parcelId, uint256 existingId);
    error AlreadyForeclosed(uint256 id);
    error NotHolder(uint256 id, address caller);

    constructor(address registrar) ERC721("Dark Questate Deed", "DQDEED") Ownable(registrar) {}

    /* ---------------------------------------------------------------- registrar */

    /// @notice Mints a deed for a title the registrar has verified.
    function mintDeed(MintParams calldata p) external onlyOwner returns (uint256 id) {
        if (bytes(p.parcelId).length == 0) revert EmptyField("parcelId");
        if (bytes(p.physicalAddress).length == 0) revert EmptyField("physicalAddress");
        if (bytes(p.legalOwner).length == 0) revert EmptyField("legalOwner");
        if (bytes(p.geoJson).length == 0) revert EmptyField("geoJson");
        if (p.operatingAgreementHash == bytes32(0)) revert EmptyField("operatingAgreementHash");

        bytes32 parcelKey = keccak256(bytes(p.parcelId));
        uint256 existing = deedIdByParcelHash[parcelKey];
        if (existing != 0) revert ParcelAlreadyRegistered(p.parcelId, existing);

        id = _nextId++;
        deedIdByParcelHash[parcelKey] = id;
        _records[id] = DeedRecord({
            legalDescription: p.legalDescription,
            physicalAddress: p.physicalAddress,
            geoJson: p.geoJson,
            parcelId: p.parcelId,
            legalOwner: p.legalOwner,
            operatingAgreementHash: p.operatingAgreementHash
        });
        _tokenURIs[id] = p.metadataUri;

        // _safeMint: a contract recipient that cannot hold ERC-721s is refused instead of
        // swallowing the deed.
        _safeMint(p.recipient, id);
        emit DeedMinted(id, p.parcelId, p.recipient, p.metadataUri);
    }

    /// @notice Records a lien (positive) or a credit (negative) against the property.
    function setDebt(uint256 id, address debtToken, int256 debtAmt) external onlyOwner {
        _requireOwned(id);
        Servicing storage s = _servicing[id];
        if (s.foreclosed) revert AlreadyForeclosed(id);
        s.debtToken = debtToken;
        s.debtAmt = debtAmt;
        emit DebtUpdated(id, debtToken, debtAmt);
    }

    /// @notice Marks the property foreclosed. Irreversible: the token no longer represents it.
    function foreclose(uint256 id) external onlyOwner {
        _requireOwned(id);
        Servicing storage s = _servicing[id];
        if (s.foreclosed) revert AlreadyForeclosed(id);
        s.foreclosed = true;
        emit Foreclosed(id);
    }

    /* ---------------------------------------------------------------- holder */

    /// @notice Appoints (or, with address(0), removes) the property manager.
    function setManager(uint256 id, address manager) external {
        address holder = _requireOwned(id);
        if (msg.sender != holder && !isApprovedForAll(holder, msg.sender) && getApproved(id) != msg.sender) {
            revert NotHolder(id, msg.sender);
        }
        address previous = _managers[id];
        _managers[id] = manager;
        emit ManagerUpdated(id, previous, manager);
    }

    /* ---------------------------------------------------------------- EIP-6065 reads */

    function legalDescriptionOf(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return _records[id].legalDescription;
    }

    function addressOf(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return _records[id].physicalAddress;
    }

    function geoJsonOf(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return _records[id].geoJson;
    }

    function parcelIdOf(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return _records[id].parcelId;
    }

    function legalOwnerOf(uint256 id) external view returns (string memory) {
        _requireOwned(id);
        return _records[id].legalOwner;
    }

    function operatingAgreementHashOf(uint256 id) external view returns (bytes32) {
        _requireOwned(id);
        return _records[id].operatingAgreementHash;
    }

    function debtOf(uint256 id) external view returns (address debtToken, int256 debtAmt, bool foreclosed) {
        _requireOwned(id);
        Servicing storage s = _servicing[id];
        return (s.debtToken, s.debtAmt, s.foreclosed);
    }

    function managerOf(uint256 id) external view returns (address) {
        address holder = _requireOwned(id);
        address manager = _managers[id];
        return manager == address(0) ? holder : manager;
    }

    /// @notice The whole deed record in one call (what the brokerage site renders).
    function deedRecord(uint256 id) external view returns (DeedRecord memory) {
        _requireOwned(id);
        return _records[id];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return _tokenURIs[id];
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC6065).interfaceId || super.supportsInterface(interfaceId);
    }

    /* ---------------------------------------------------------------- internals */

    /// @dev Ends a manager appointment whenever the deed moves between two holders.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            address previous = _managers[tokenId];
            if (previous != address(0)) {
                delete _managers[tokenId];
                emit ManagerUpdated(tokenId, previous, address(0));
            }
        }
    }
}
