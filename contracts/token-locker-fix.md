# Fix for Issue #717: Update Global Stats in token-locker's create_split_lock

## Problem
The `create_split_lock` function in token-locker contract transfers `total_amount` into the contract and creates N Lock records, but it does NOT update:
- `DataKey::TotalLocked` for the token
- `DataKey::UniqueTokenCount` 
- `DataKey::GlobalLockCount`

## Impact
After any split lock is created via token-locker, the global accounting is broken:
- `get_total_locked(token)` permanently understates reality
- `get_global_stats()` fails to reflect actual TVL and lock count
- Later `withdraw` calls will decrement `TotalLocked` for amounts that were never added, causing potential underflow

## Solution
Add the missing global stats update block to `create_split_lock`, matching the pattern used in `create_lock` and lp-locker's `create_split_lock`.

## Code Changes Required

In `contracts/token-locker/src/lib.rs`, locate the `create_split_lock` function (around line where lock records are created).

After creating all Lock records and transferring the total amount, add:

```rust
// Update global accounting
let token_key = token.clone();

// Update TotalLocked
let current_total: u128 = env
    .storage()
    .instance()
    .get(&DataKey::TotalLocked(token_key.clone()))
    .unwrap_or(0);
let new_total = current_total.checked_add(total_amount)
    .ok_or(Error::Overflow)?;
env.storage()
    .instance()
    .set(&DataKey::TotalLocked(token_key.clone()), &new_total);

// Update UniqueTokenCount if this is the first lock for this token
if !env.storage().instance().has(&DataKey::UniqueTokenCount) {
    env.storage()
        .instance()
        .set(&DataKey::UniqueTokenCount, &1u32);
} else if current_total == 0 {
    let count: u32 = env.storage()
        .instance()
        .get(&DataKey::UniqueTokenCount)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::UniqueTokenCount, &count.checked_add(1).ok_or(Error::Overflow)?);
}

// Update GlobalLockCount
let current_count: u32 = env
    .storage()
    .instance()
    .get(&DataKey::GlobalLockCount)
    .unwrap_or(0);
let new_count = current_count.checked_add(num_locks as u32)
    .ok_or(Error::Overflow)?;
env.storage()
    .instance()
    .set(&DataKey::GlobalLockCount, &new_count);

// Extend TTL for instance storage
env.storage().instance().extend_ttl(
    17280u32.saturating_mul(30),
    17280u32.saturating_mul(60),
);
```

## Verification
After this fix:
1. `get_total_locked(token)` will correctly include split-lock amounts
2. `get_global_stats()` will count split locks in `global_lock_count` 
3. `withdraw` will have matching accounting (amounts deducted from `TotalLocked` were actually added)

## Testing
- Test `create_split_lock` followed by `get_total_locked(token)` matches transferred amount
- Test `get_global_stats()` includes split locks in count
- Test repeated split locks accumulate correctly in TotalLocked and GlobalLockCount
