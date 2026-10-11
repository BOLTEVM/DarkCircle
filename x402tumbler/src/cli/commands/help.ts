/**
 * DarkCircle Protocol: CLI Help Documentation
 * File: src/cli/commands/help.ts
 */

export function getHelpText(command?: string): string {
  switch (command?.toLowerCase()) {
    case "pay":
      return `darkcircle pay — Settle payment via ZK unshield or transparent HTTP 402 interception

USAGE:
  darkcircle pay --recipient <address> --amount <amount> [options]
  darkcircle pay --url <endpoint> [options]

OPTIONS:
  -r, --recipient <address>   Vendor destination address for direct unshield
  -a, --amount <amount>       Amount to pay (e.g. "5.0" or atomic units)
  --url <endpoint>            Target HTTP 402 protected resource URL
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address (default: WQUAI)
  --direct                    Bypass Relayer broadcast (direct unshield)
  --max-cap <cap>             Override spending policy maximum cap
  --invoice-id <id>           Custom invoice identifier for payment tracking
  --json                      Output structured JSON receipt
  -o, --output <file>         Write receipt output to specified file path
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle pay --recipient 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 5.0 --json
  darkcircle pay --url https://api.enterprise.com/v1/protected/analytics
`;

    case "invoice":
      return `darkcircle invoice — Generate HTTP 402 challenge with ephemeral stealth address

USAGE:
  darkcircle invoice --amount <amount> [options]

OPTIONS:
  -a, --amount <amount>       Required payment amount (e.g. "5.0" or atomic integer)
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address (default: WQUAI)
  -s, --symbol <symbol>       Token symbol display (default: "WQUAI")
  -d, --decimals <decimals>   Token decimals (default: the token's own, 18)
  --resource <uri>            Resource URI path requiring payment (default: "/api/v1/protected/resource")
  --ttl <seconds>             Invoice time-to-live in seconds (default: 900)
  --derivation-mode <mode>    Ephemeral address derivation: "quai" (default), "secp256k1", or "fast" (simulation only)
  -k, --merchant-key <key>    Override merchant master secret key
  --json                      Output structured JSON challenge body
  -o, --output <file>         Write invoice challenge to specified file path
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle invoice --amount 5.0 --json
  darkcircle invoice --amount 10.0 --resource /api/v1/protected/ai-inference --ttl 1800
`;

    case "sweep":
      return `darkcircle sweep — Sweep settled ephemeral balances into shielded Railgun pool

USAGE:
  darkcircle sweep --invoice <invoice_id> [options]
  darkcircle sweep --all [options]

OPTIONS:
  -i, --invoice <id>          Specific invoice ID to sweep and shield
  --all                       Batch sweep all eligible settled invoices
  --threshold <amount>        Minimum token balance threshold to trigger sweep
  -a, --address <address>     Direct ephemeral address to sweep
  -k, --private-key <key>     Ephemeral private key for single-use unshield
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address (default: WQUAI)
  --json                      Output structured JSON sweep receipt
  -o, --output <file>         Write sweep results to specified file path
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle sweep --invoice inv_analytics_001 --json
  darkcircle sweep --all --json
`;

    case "audit":
      return `darkcircle audit — Reconstruct accounting journal and export compliance reports

USAGE:
  darkcircle audit [options]

OPTIONS:
  -k, --viewing-key <token>   Auditor viewing key token or hex scalar
  -f, --format <json|csv>     Export format (default: "json")
  --json                      Shortcut for --format json
  --csv                       Shortcut for --format csv
  --verify <file>             Verify SHA-256 tamper-evident checksum of an exported report
  --reconcile                 Verify double-entry reconciliation invariant
  --entity <name>             Audited entity name (default: "DarkCircle Corporate Treasury")
  --from-date <iso>           Filter transactions after ISO timestamp
  --to-date <iso>             Filter transactions before ISO timestamp
  -t, --token <address>       Filter transactions by token contract address
  -c, --counterparty <addr>   Filter transactions by counterparty address
  -d, --direction <dir>       Filter by direction ("INBOUND" | "OUTBOUND")
  -o, --output <file>         Write audit report to specified file path
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle audit --format json
  darkcircle audit --format csv --output audit_report.csv
  darkcircle audit --verify audit_report.json
  darkcircle audit --reconcile
`;

    case "balance":
      return `darkcircle balance — Query shielded treasury and on-chain account balances

USAGE:
  darkcircle balance [options]

OPTIONS:
  -a, --address <address>     Query public balance of a specific on-chain address
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address (default: WQUAI)
  -k, --viewing-key <key>     Corporate viewing key for shielded balance derivation
  --json                      Output structured JSON balance object
  -o, --output <file>         Write balance report to specified file path
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle balance
  darkcircle balance --json
  darkcircle balance --address 0x004E3d0a19fA256E0A8903528605dE5acD8Faa72
`;

    case "shield":
      return `darkcircle shield - Deposit tokens from a public Quai address into the shielded pool

USAGE:
  darkcircle shield --amount <amount> [options]

OPTIONS:
  -a, --amount <amount>       Amount to shield (e.g. "10.0")
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address (default: WQUAI)
  --depositor <address>       Funding address (default: the operating wallet)
  --wrap                      Wrap native QUAI into WQUAI first (WQUAI only)
  --json                      Output structured JSON
  -h, --help                  Show this help message

EXAMPLES:
  darkcircle shield --amount 10.0
  darkcircle shield --amount 5 --wrap --json
`;

    case "checklist":
      return `darkcircle checklist - Pre-flight checks for a shielded-pool transaction

USAGE:
  darkcircle checklist <shield|unshield|receive|sweep|audit> [options]

OPTIONS:
  --address <address>         Recipient (unshield) or depositor (shield)
  -a, --amount <amount>       Amount
  -t, --token <symbol|address>  WQUAI, WQI or a registered contract address
  --invoice <id>              Invoice to check (sweep)
  --wrap                      Shield: wrap native QUAI first
  --json                      Output structured JSON
  -h, --help                  Show this help message

Exits 0 when nothing blocks the transaction, 1 when a blocking check fails.

EXAMPLES:
  darkcircle checklist unshield --address 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 5
  darkcircle checklist audit
`;

    default:
      return `DarkCircle: Enterprise x402 Privacy Suite & Railgun Tumbler

USAGE:
  darkcircle <command> [options]

COMMANDS:
  pay       Settle HTTP 402 challenge via unshield or direct payment to vendor
  invoice   Generate HTTP 402 challenge with ephemeral stealth address
  sweep     Sweep settled ephemeral invoice balances into shielded Railgun pool
  audit     Reconstruct accounting journal, verify reconciliation, and export reports
  balance   Query shielded treasury and on-chain operating balances
  shield    Deposit tokens from a public Quai address into the shielded pool
  checklist Pre-flight checks for a shield, payment, receive, sweep or audit export
  help      Display help information for a command

GLOBAL OPTIONS:
  -h, --help      Display usage instructions
  -v, --version   Display software version

EXAMPLES:
  darkcircle balance --json
  darkcircle invoice --amount 5.0 --json
  darkcircle pay --recipient 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 5.0
  darkcircle pay --url http://localhost:8080/api/v1/protected/analytics
  darkcircle sweep --all --json
  darkcircle audit --format json --output audit.json
  darkcircle audit --verify audit.json
`;
  }
}
