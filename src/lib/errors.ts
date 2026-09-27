import { NETWORK } from "@/lib/stellar"

export interface StructuredError {
  code: string
  title: string
  message: string
  recovery: string | null
  link: { label: string; url: string } | null
  i18nKey: string
}

// Map Soroban contract error codes → structured errors.
// Every variant in the Rust ContractError enum must have a corresponding entry
// here so users see a meaningful message instead of the generic fallback.
const CONTRACT_ERRORS: Record<string, Omit<StructuredError, "code">> = {
  AmountMustBePositive: {
    title: "errors.amountMustBePositive.title",
    message: "errors.amountMustBePositive.message",
    recovery: "errors.amountMustBePositive.recovery",
    link: null,
    i18nKey: "errors.amountMustBePositive",
  },
  UnlockMustBeFuture: {
    title: "errors.unlockMustBeFuture.title",
    message: "errors.unlockMustBeFuture.message",
    recovery: "errors.unlockMustBeFuture.recovery",
    link: null,
    i18nKey: "errors.unlockMustBeFuture",
  },
  StillLocked: {
    title: "errors.stillLocked.title",
    message: "errors.stillLocked.message",
    recovery: "errors.stillLocked.recovery",
    link: null,
    i18nKey: "errors.stillLocked",
  },
  AlreadyWithdrawn: {
    title: "errors.alreadyWithdrawn.title",
    message: "errors.alreadyWithdrawn.message",
    recovery: null,
    link: null,
    i18nKey: "errors.alreadyWithdrawn",
  },
  NothingToRelease: {
    title: "errors.nothingToRelease.title",
    message: "errors.nothingToRelease.message",
    recovery: "errors.nothingToRelease.recovery",
    link: null,
    i18nKey: "errors.nothingToRelease",
  },
  CanOnlyExtend: {
    title: "errors.canOnlyExtend.title",
    message: "errors.canOnlyExtend.message",
    recovery: "errors.canOnlyExtend.recovery",
    link: null,
    i18nKey: "errors.canOnlyExtend",
  },
  LockDurationTooLong: {
    title: "errors.lockDurationTooLong.title",
    message: "errors.lockDurationTooLong.message",
    recovery: "errors.lockDurationTooLong.recovery",
    link: null,
    i18nKey: "errors.lockDurationTooLong",
  },
  VestingEndBeforeStart: {
    title: "errors.vestingEndBeforeStart.title",
    message: "errors.vestingEndBeforeStart.message",
    recovery: "errors.vestingEndBeforeStart.recovery",
    link: null,
    i18nKey: "errors.vestingEndBeforeStart",
  },
  TooFewBeneficiaries: {
    title: "errors.tooFewBeneficiaries.title",
    message: "errors.tooFewBeneficiaries.message",
    recovery: "errors.tooFewBeneficiaries.recovery",
    link: null,
    i18nKey: "errors.tooFewBeneficiaries",
  },
  TooManyBeneficiaries: {
    title: "errors.tooManyBeneficiaries.title",
    message: "errors.tooManyBeneficiaries.message",
    recovery: "errors.tooManyBeneficiaries.recovery",
    link: null,
    i18nKey: "errors.tooManyBeneficiaries",
  },
  SharesMustSum10000: {
    title: "errors.sharesMustSum10000.title",
    message: "errors.sharesMustSum10000.message",
    recovery: "errors.sharesMustSum10000.recovery",
    link: null,
    i18nKey: "errors.sharesMustSum10000",
  },
  RateLimitExceeded: {
    title: "errors.rateLimitExceeded.title",
    message: "errors.rateLimitExceeded.message",
    recovery: "errors.rateLimitExceeded.recovery",
    link: null,
    i18nKey: "errors.rateLimitExceeded",
  },
  LockDurationTooShort: {
    title: "errors.lockDurationTooShort.title",
    message: "errors.lockDurationTooShort.message",
    recovery: "errors.lockDurationTooShort.recovery",
    link: null,
    i18nKey: "errors.lockDurationTooShort",
  },
  ExtensionLimitExceeded: {
    title: "errors.extensionLimitExceeded.title",
    message: "errors.extensionLimitExceeded.message",
    recovery: "errors.extensionLimitExceeded.recovery",
    link: null,
    i18nKey: "errors.extensionLimitExceeded",
  },
  // --- Previously missing contract error variants, now mapped ---
  AmountOverflow: {
    title: "errors.amountOverflow.title",
    message: "errors.amountOverflow.message",
    recovery: "errors.amountOverflow.recovery",
    link: null,
    i18nKey: "errors.amountOverflow",
  },
  NotAdmin: {
    title: "errors.notAdmin.title",
    message: "errors.notAdmin.message",
    recovery: "errors.notAdmin.recovery",
    link: null,
    i18nKey: "errors.notAdmin",
  },
  NoPendingAdmin: {
    title: "errors.noPendingAdmin.title",
    message: "errors.noPendingAdmin.message",
    recovery: "errors.noPendingAdmin.recovery",
    link: null,
    i18nKey: "errors.noPendingAdmin",
  },
  NotPendingAdmin: {
    title: "errors.notPendingAdmin.title",
    message: "errors.notPendingAdmin.message",
    recovery: "errors.notPendingAdmin.recovery",
    link: null,
    i18nKey: "errors.notPendingAdmin",
  },
  ReentrancyDetected: {
    title: "errors.reentrancyDetected.title",
    message: "errors.reentrancyDetected.message",
    recovery: "errors.reentrancyDetected.recovery",
    link: null,
    i18nKey: "errors.reentrancyDetected",
  },
  // --- LP-locker specific ---
  IdenticalTokens: {
    title: "errors.identicalTokens.title",
    message: "errors.identicalTokens.message",
    recovery: "errors.identicalTokens.recovery",
    link: null,
    i18nKey: "errors.identicalTokens",
  },
  NotInitialized: {
    title: "errors.notInitialized.title",
    message: "errors.notInitialized.message",
    recovery: "errors.notInitialized.recovery",
    link: null,
    i18nKey: "errors.notInitialized",
  },
  LockNotFound: {
    title: "errors.lockNotFound.title",
    message: "errors.lockNotFound.message",
    recovery: "errors.lockNotFound.recovery",
    link: null,
    i18nKey: "errors.lockNotFound",
  },
  ContractPaused: {
    title: "errors.contractPaused.title",
    message: "errors.contractPaused.message",
    recovery: "errors.contractPaused.recovery",
    link: null,
    i18nKey: "errors.contractPaused",
  },
}

// Map wallet/network errors
function parseWalletError(err: unknown): StructuredError | null {
  const msg = String((err as Error)?.message ?? "").toLowerCase()

  if (msg.includes("user rejected") || msg.includes("user denied")) {
    return {
      code: "USER_REJECTED",
      i18nKey: "errors.userRejected",
      title: "errors.userRejected.title",
      message: "errors.userRejected.message",
      recovery: "errors.userRejected.recovery",
      link: null,
    }
  }
  if (msg.includes("insufficient balance") || msg.includes("underfunded")) {
    return {
      code: "INSUFFICIENT_BALANCE",
      i18nKey: "errors.insufficientBalance",
      title: "errors.insufficientBalance.title",
      message: "errors.insufficientBalance.message",
      recovery: "errors.insufficientBalance.recovery",
      link: null,
    }
  }
  if (msg.includes("wrong network") || msg.includes("network mismatch")) {
    return {
      code: "WRONG_NETWORK",
      i18nKey: "errors.wrongNetwork",
      title: "errors.wrongNetwork.title",
      message: "errors.wrongNetwork.message",
      recovery: "errors.wrongNetwork.recovery",
      link: null,
    }
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return {
      code: "TIMEOUT",
      i18nKey: "errors.timeout",
      title: "errors.timeout.title",
      message: "errors.timeout.message",
      recovery: "errors.timeout.recovery",
      link: { label: "Check on Stellar Expert", url: `https://stellar.expert/explorer/${NETWORK.networkName}` },
    }
  }
  return null
}

export function parseError(err: unknown): StructuredError {
  // Try wallet-level errors first
  const walletErr = parseWalletError(err)
  if (walletErr) return walletErr

  // Try to extract Soroban contract error code. The numeric code alternative
  // is tried first by the regex engine because it starts earlier in the
  // string (e.g. "Error(Contract, #1): AmountMustBePositive"), so it must
  // capture the trailing symbolic name itself rather than leaving that to a
  // separate alternative — otherwise `code` ends up as the digit string,
  // which never matches a key in CONTRACT_ERRORS.
  const raw = String((err as { message?: string })?.message ?? "")
  const match = raw.match(/Error\(Contract,\s*#\d+\)\s*:\s*([A-Za-z]+)|([A-Z][a-zA-Z]+Error|[A-Z][a-zA-Z]+)/)
  const code = match?.[1] ?? match?.[2] ?? "UNKNOWN"

  if (code in CONTRACT_ERRORS) {
    return { code, ...CONTRACT_ERRORS[code] }
  }

  // Generic fallback
  // IMPORTANT: do not return raw error text to the UI.
  return {
    code: "UNKNOWN",
    i18nKey: "errors.unknown",
    title: "errors.unknown.title",
    message: "errors.unknown.message",
    recovery: "errors.unknown.recovery",
    link: null,
  }
}
