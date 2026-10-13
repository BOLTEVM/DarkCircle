// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

/**
 * @title IERC6065: Real Estate Token
 * @notice The EIP-6065 read surface. A deed token implementing it is also an ERC-721.
 * @dev Only the functions declared here count toward `type(IERC6065).interfaceId`.
 */
interface IERC6065 {
    /// @notice MUST be emitted if the property is ever foreclosed.
    event Foreclosed(uint256 id);

    /// @notice Legal description of the property, as recorded on the physical deed.
    function legalDescriptionOf(uint256 _id) external view returns (string memory);

    /// @notice Street address of the property.
    function addressOf(uint256 _id) external view returns (string memory);

    /// @notice RFC 7946 GeoJSON of the property boundary.
    function geoJsonOf(uint256 _id) external view returns (string memory);

    /// @notice Parcel identifier assigned by the local authority (APN / cadastral id).
    function parcelIdOf(uint256 _id) external view returns (string memory);

    /// @notice Legal entity named on the deed.
    function legalOwnerOf(uint256 _id) external view returns (string memory);

    /// @notice keccak256 of the legal entity's operating agreement.
    function operatingAgreementHashOf(uint256 _id) external view returns (bytes32);

    /**
     * @notice Debt or credit attached to the property, and whether it has been foreclosed.
     * @return debtToken Token the amount is denominated in (address(0) for the native coin).
     * @return debtAmt Positive is a lien owed, negative is a credit owed to the holder.
     * @return foreclosed True once the real-world property is severed from the token.
     */
    function debtOf(uint256 _id) external view returns (address debtToken, int256 debtAmt, bool foreclosed);

    /// @notice Address entitled to act for the property.
    function managerOf(uint256 _id) external view returns (address);
}
