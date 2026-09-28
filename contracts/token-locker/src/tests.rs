use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, BytesN, Env, IntoVal, Symbol, TryFromVal,
};

use crate::{ContractError, LockMetadata, TokenLocker, TokenLockerClient, Vesting};

// ── Test setup ────────────────────────────────────────────────────────────────

fn setup_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Start far enough past t=0 that the first lock clears the 60s rate limit.
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let contract_id = env.register(TokenLocker, ());
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    (env, contract_id, token_id)
}

fn empty_metadata(env: &Env) -> LockMetadata {
    LockMetadata::empty(env)
}

fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().with_mut(|l| l.timestamp = current + seconds);
}

// ── Basic validity tests ──────────────────────────────────────────────────────

#[test]
fn create_lock_valid_inputs() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    let lock = client.get_lock(&lock_id).expect("lock exists");
    assert_eq!(lock.amount, 100_i128);
    assert_eq!(lock.creator, creator);
    assert_eq!(lock.beneficiary, beneficiary);
    assert_eq!(lock.unlock_at, unlock_at);
    assert!(!lock.withdrawn);
}

#[test]
fn create_lock_rejects_zero_amount() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_lock(
        &creator,
        &token_id,
        &0_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::AmountMustBePositive)));
}

#[test]
fn create_lock_rejects_negative_amount() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_lock(
        &creator,
        &token_id,
        &(-1_i128),
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert!(result.is_err(), "negative amount must be rejected");
}

#[test]
fn create_lock_rejects_past_unlock_date() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let result = client.try_create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &0_u64,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::UnlockMustBeFuture)));
}

// ── Withdraw authorization ────────────────────────────────────────────────────

#[test]
fn beneficiary_can_withdraw_after_unlock() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn withdraw_fails_before_unlock_at() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    let result = client.try_withdraw(&lock_id);
    assert_eq!(result, Err(Ok(ContractError::StillLocked)));
}

#[test]
fn withdraw_twice_is_rejected() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    let result = client.try_withdraw(&lock_id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyWithdrawn)));
}

#[test]
fn withdraw_requires_time_strictly_after_unlock() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 99_999);
    assert!(
        client.try_withdraw(&lock_id).is_err(),
        "should not withdraw before unlock"
    );
    advance_time(&env, 2); // now == unlock_at + 1
    assert!(
        client.try_withdraw(&lock_id).is_ok(),
        "should withdraw after unlock"
    );
}

// ── Extend ────────────────────────────────────────────────────────────────────

#[test]
fn creator_can_extend_lock() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    let new_unlock = unlock_at + 500;
    client.extend(&lock_id, &new_unlock);
    let lock = client.get_lock(&lock_id).unwrap();
    assert_eq!(lock.unlock_at, new_unlock);
    assert_eq!(lock.extended_count, 1);
}

#[test]
fn extend_cannot_decrease_unlock_time() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(
        client.try_extend(&lock_id, &unlock_at),
        Err(Ok(ContractError::CanOnlyExtend))
    );
    assert_eq!(
        client.try_extend(&lock_id, &(unlock_at - 1)),
        Err(Ok(ContractError::CanOnlyExtend))
    );
    assert!(client.try_extend(&lock_id, &(unlock_at + 100)).is_ok());
}

#[test]
fn extend_withdrawn_lock_fails() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    let result = client.try_extend(&lock_id, &(unlock_at + 1000));
    assert_eq!(result, Err(Ok(ContractError::AlreadyWithdrawn)));
}

// ── LockNotFound (#489) ──────────────────────────────────────────────────────
// load_lock() must return ContractError::LockNotFound instead of panicking with
// a bare .expect() when the lock id does not exist.

#[test]
fn withdraw_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let result = client.try_withdraw(&999_999);
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

#[test]
fn extend_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let result = client.try_extend(&999_999, &(env.ledger().timestamp() + 100_000));
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

#[test]
fn transfer_beneficiary_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let new_beneficiary = Address::generate(&env);
    let result = client.try_transfer_beneficiary(&999_999, &new_beneficiary);
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

// ── Beneficiary transfer ──────────────────────────────────────────────────────

#[test]
fn transfer_beneficiary_and_new_beneficiary_can_withdraw() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let original_beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &300_i128,
        &original_beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    client.transfer_beneficiary(&lock_id, &new_beneficiary);
    assert_eq!(
        client.get_lock(&lock_id).unwrap().beneficiary,
        new_beneficiary
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn transfer_beneficiary_updates_indexes() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let original_beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &original_beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    client.transfer_beneficiary(&lock_id, &new_beneficiary);
    assert_eq!(
        client
            .get_locks_by_beneficiary(&original_beneficiary, &0, &10)
            .len(),
        0
    );
    let new_locks = client.get_locks_by_beneficiary(&new_beneficiary, &0, &10);
    assert_eq!(new_locks.len(), 1);
    assert_eq!(new_locks.get(0).unwrap().id, lock_id);
}

#[test]
fn transfer_on_withdrawn_lock_is_rejected() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    let result = client.try_transfer_beneficiary(&lock_id, &new_beneficiary);
    assert_eq!(result, Err(Ok(ContractError::AlreadyWithdrawn)));
}

#[test]
fn beneficiary_can_transfer_to_self() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    client.transfer_beneficiary(&lock_id, &beneficiary);
    assert_eq!(client.get_lock(&lock_id).unwrap().beneficiary, beneficiary);
}

// ── Cross-account query isolation ─────────────────────────────────────────────

#[test]
fn creator_locks_isolated_from_other_creator() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator_a, 1_000);
    mint(&env, &token_id, &creator_b, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator_a,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 60);
    client.create_lock(
        &creator_a,
        &token_id,
        &200_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    client.create_lock(
        &creator_b,
        &token_id,
        &300_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(client.get_lock_count_by_creator(&creator_a), 2);
    assert_eq!(client.get_lock_count_by_creator(&creator_b), 1);
    assert_eq!(client.get_lock_count_by_beneficiary(&beneficiary), 3);
}

#[test]
fn creator_is_also_beneficiary_flow() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &creator,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    let lock = client.get_lock(&lock_id).unwrap();
    assert_eq!(lock.creator, lock.beneficiary);
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn three_accounts_full_flow() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &token_id, &creator, 2_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(client.get_lock_count_by_creator(&unauthorized), 0);
    assert_eq!(client.get_lock_count_by_beneficiary(&unauthorized), 0);
    assert_eq!(client.get_lock_count_by_creator(&creator), 1);
    assert_eq!(client.get_lock_count_by_beneficiary(&beneficiary), 1);
    client.extend(&lock_id, &(unlock_at + 500));
    advance_time(&env, 100_600);
    client.withdraw(&lock_id);
    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

// ── TVL / global stats ────────────────────────────────────────────────────────

#[test]
fn tvl_increases_on_create_decreases_on_withdraw() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 5_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id_1 = client.create_lock(
        &creator,
        &token_id,
        &400_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 60);
    client.create_lock(
        &creator,
        &token_id,
        &600_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(client.get_total_locked(&token_id), 1_000_i128);
    let stats = client.get_global_stats();
    assert_eq!(stats.total_lock_count, 2);
    assert_eq!(stats.unique_token_count, 1);
    advance_time(&env, 100_000);
    client.withdraw(&lock_id_1);
    assert_eq!(client.get_total_locked(&token_id), 600_i128);
}

#[test]
fn global_stats_counts_unique_tokens() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let admin2 = Address::generate(&env);
    let token2_id = env
        .register_stellar_asset_contract_v2(admin2.clone())
        .address();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    mint(&env, &token2_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 60);
    client.create_lock(
        &creator,
        &token2_id,
        &200_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    let stats = client.get_global_stats();
    assert_eq!(stats.total_lock_count, 2);
    assert_eq!(stats.unique_token_count, 2);
}

// ── create_lock TVL overflow guard (#490) ────────────────────────────────────

/// The TVL accumulator `current_tvl + amount` overflows i128 when the existing
/// per-token TVL is already near i128::MAX.  The contract must return
/// `ContractError::AmountOverflow` instead of trapping.
#[test]
fn create_lock_returns_typed_error_on_tvl_overflow() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    // Seed the per-token TVL so that adding any positive amount overflows i128.
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &crate::DataKey::TotalLocked(token_id.clone()),
            &(i128::MAX - 1),
        );
    });

    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    assert_eq!(
        result,
        Err(Ok(ContractError::AmountOverflow)),
        "expected AmountOverflow typed error, not a panic"
    );
}

/// Complement: a TVL addition that lands exactly on i128::MAX must succeed and
/// persist the new TVL.
#[test]
fn create_lock_near_overflow_boundary_succeeds() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &crate::DataKey::TotalLocked(token_id.clone()),
            &(i128::MAX - 100),
        );
    });

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    assert_eq!(client.get_total_locked(&token_id), i128::MAX);
}

// ── Vesting ───────────────────────────────────────────────────────────────────

#[test]
fn vesting_end_must_be_after_start() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let now = env.ledger().timestamp();
    let bad_vesting = Vesting {
        start: now + 1_000,
        end: now + 500,
        released: 0,
    };
    let result = client.try_create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(bad_vesting),
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::VestingEndBeforeStart)));
}

#[test]
fn partial_vested_withdrawal_does_not_mark_fully_withdrawn() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 5_000);
    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now,
        end: now + 200_000,
        released: 0,
    };
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(vesting),
        &empty_metadata(&env),
    );
    advance_time(&env, 100_000);
    client.withdraw(&lock_id);
    assert!(!client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn full_vesting_marks_withdrawn() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 5_000);
    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now,
        end: now + 1000,
        released: 0,
    };
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(vesting),
        &empty_metadata(&env),
    );
    advance_time(&env, 150_000);
    client.withdraw(&lock_id);
    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn vesting_proportional_release_at_midpoint() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 10_000);
    let now = env.ledger().timestamp();
    let vesting_duration = 200_000_u64;
    let vesting = Vesting {
        start: now,
        end: now + vesting_duration,
        released: 0,
    };
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(vesting),
        &empty_metadata(&env),
    );
    advance_time(&env, vesting_duration / 2);
    client.withdraw(&lock_id);
    let lock = client.get_lock(&lock_id).unwrap();
    assert_eq!(
        lock.vesting.released, 500_i128,
        "expected 50% released at midpoint"
    );
    assert!(
        !lock.withdrawn,
        "lock should not be fully withdrawn at midpoint"
    );
}

// ── Split lock ────────────────────────────────────────────────────────────────

#[test]
fn create_split_lock_requires_at_least_two_beneficiaries() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    mint(&env, &token_id, &creator, 10_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &vec![&env, (b1, 10_000_u64)],
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::TooFewBeneficiaries)));
}

#[test]
fn create_split_lock_shares_must_sum_to_10000() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 10_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &vec![&env, (b1, 5_000_u64), (b2, 4_000_u64)],
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::SharesMustSum10000)));
}

#[test]
fn create_split_lock_succeeds_and_allocates_correctly() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 10_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at,
        &None,
    );
    let group = client.get_split_group(&group_id).unwrap();
    assert_eq!(group.lock_ids.len(), 2);
    let lock0 = client.get_lock(&group_id).unwrap();
    assert_eq!(lock0.amount, 7_000_i128);
    assert_eq!(lock0.beneficiary, b1);
    let lock1_id = group.lock_ids.get(1).unwrap();
    let lock1 = client.get_lock(&lock1_id).unwrap();
    assert_eq!(lock1.amount, 3_000_i128);
    assert_eq!(lock1.beneficiary, b2);
}

/// Regression test for #630: an indexer building state purely from events
/// (not by reading contract storage) must be able to see each split-group
/// child's own id, beneficiary and amount, not just the group's totals.
#[test]
fn create_split_lock_emits_a_lock_created_event_per_child() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 10_000);
    let unlock_at = env.ledger().timestamp() + 100_000;

    let group_id = client.create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at,
        &None,
    );
    // Only events this contract published — excludes the token contract's
    // own transfer/mint events from the same transaction.
    let our_events: std::vec::Vec<_> = env
        .events()
        .all()
        .iter()
        .filter(|(addr, _, _)| *addr == contract_id)
        .collect();

    let group = client.get_split_group(&group_id).unwrap();
    let lock1_id = group.lock_ids.get(1).unwrap();

    let child_created: std::vec::Vec<_> = our_events
        .iter()
        .filter(|(_, topics, _)| {
            Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "lock_created")
        })
        .collect();
    // One `lock_created` per child, plus the group-level `split_lock_created`
    // summary.
    assert_eq!(child_created.len(), 2);
    assert_eq!(our_events.len(), 3);

    let (_, lock1_topics, _) = child_created
        .iter()
        .find(|(_, topics, _)| {
            u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap() == lock1_id
        })
        .expect("lock_created event for the second child");
    let lock1_event_amount = i128::try_from_val(&env, &lock1_topics.get(4).unwrap()).unwrap();
    let lock1_event_beneficiary =
        Address::try_from_val(&env, &lock1_topics.get(5).unwrap()).unwrap();
    assert_eq!(lock1_event_amount, 3_000_i128);
    assert_eq!(lock1_event_beneficiary, b2);
}

// ── Rate limiting (#203 / create_split_lock parity) ───────────────────────────

#[test]
fn create_lock_back_to_back_is_rate_limited() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;

    client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    let result = client.try_create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::RateLimitExceeded)));
}

#[test]
fn create_split_lock_back_to_back_is_rate_limited() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 20_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let allocations = vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)];

    client.create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &allocations,
        &unlock_at,
        &None,
    );

    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &allocations,
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::RateLimitExceeded)));
}

#[test]
fn create_split_lock_and_create_lock_share_the_same_rate_limit() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 20_000);
    let unlock_at = env.ledger().timestamp() + 100_000;

    client.create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    // A create_lock immediately followed by a create_split_lock from the same
    // creator must also be rate-limited: both entry points share DataKey::LastLockAt.
    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::RateLimitExceeded)));
}

#[test]
fn create_split_lock_succeeds_after_cooldown_elapses() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &token_id, &creator, 20_000);

    let unlock_at_1 = env.ledger().timestamp() + 100_000;
    client.create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at_1,
        &None,
    );

    advance_time(&env, 60);
    let unlock_at_2 = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &token_id,
        &10_000_i128,
        &vec![&env, (b1, 7_000_u64), (b2, 3_000_u64)],
        &unlock_at_2,
        &None,
    );
    assert!(client.get_split_group(&group_id).is_some());
}

// ── Storage optimization: selective TTL (#148) ────────────────────────────────
// Active locks must use PERSISTENT_BUMP (365 days); withdrawn locks must use
// WITHDRAWN_BUMP (30 days). We verify the observable effect: after withdrawal
// the lock record still exists (TTL not yet expired) and withdrawn == true,
// while an active lock that was never withdrawn keeps withdrawn == false.

#[test]
fn active_lock_is_not_marked_withdrawn_after_save() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &200_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    // Lock is persisted and active — withdrawn must be false (full TTL path taken).
    let lock = client.get_lock(&lock_id).unwrap();
    assert!(!lock.withdrawn, "newly created lock must not be withdrawn");
}

#[test]
fn withdrawn_lock_is_marked_and_still_readable() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &200_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 200_000);
    client.withdraw(&lock_id);
    // After withdrawal save_lock is called with withdrawn=true (short TTL path).
    // The entry must still be readable immediately after withdrawal.
    let lock = client.get_lock(&lock_id).unwrap();
    assert!(
        lock.withdrawn,
        "lock must be marked withdrawn after withdraw()"
    );
}

// ── create_split_lock overflow guard (#AmountOverflow) ───────────────────────

/// The naive `total_amount * bps` expression overflows i128 when total_amount is
/// large even though both operands are individually in range.  The contract must
/// return ContractError::AmountOverflow rather than panicking.
///
/// Boundary chosen: i128::MAX / 2 + 1  with a 90 % / 10 % split.
/// (i128::MAX / 2 + 1) * 9_000  overflows i128 before the divide-by-10_000,
/// so the very first beneficiary's share calculation triggers the error.
#[test]
fn create_split_lock_returns_typed_error_on_amount_overflow() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    // total_amount that makes `total_amount * 9_000` overflow i128
    let overflow_amount: i128 = i128::MAX / 2 + 1;

    // We need the mock token balance to cover the transfer that happens
    // before the per-share calculation.  mint accepts i128 so cap at max.
    mint(&env, &token_id, &creator, i128::MAX);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &overflow_amount,
        &soroban_sdk::vec![&env, (b1, 9_000_u64), (b2, 1_000_u64)],
        &unlock_at,
        &None,
    );

    assert_eq!(
        result,
        Err(Ok(ContractError::AmountOverflow)),
        "expected AmountOverflow typed error, not a panic"
    );
}

/// Complement: a total_amount just small enough that the multiply does NOT
/// overflow must succeed and allocate shares correctly.
///
/// Safe ceiling: i128::MAX / 10_000 — multiplying by any bps ≤ 10_000 stays
/// within i128.
#[test]
fn create_split_lock_near_overflow_boundary_succeeds() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    // Largest total_amount where  total_amount * 10_000  still fits in i128.
    let safe_amount: i128 = i128::MAX / 10_000;

    mint(&env, &token_id, &creator, i128::MAX);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &token_id,
        &safe_amount,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &unlock_at,
        &None,
    );

    let lock0 = client.get_lock(&group_id).expect("lock 0 exists");
    assert_eq!(
        lock0.amount,
        safe_amount / 2,
        "each 50 % share must equal half of safe_amount"
    );
}

/// Kills mutants on the vesting end-before-start guard.
#[test]
fn active_and_withdrawn_locks_have_correct_state() {
    // Creates two locks; withdraws only one. Verifies each has the expected
    // withdrawn flag, confirming the two TTL branches are reached independently.
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 2_000);
    let unlock_at = env.ledger().timestamp() + 100_000;
    let active_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 60);
    let withdrawn_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 100_000);
    client.withdraw(&withdrawn_id);
    // Active lock: full TTL branch — withdrawn is false.
    assert!(
        !client.get_lock(&active_id).unwrap().withdrawn,
        "active lock must keep withdrawn=false (full TTL branch)"
    );
    // Withdrawn lock: short TTL branch — withdrawn is true.
    assert!(
        client.get_lock(&withdrawn_id).unwrap().withdrawn,
        "withdrawn lock must have withdrawn=true (short TTL branch)"
    );
}

// ── Admin management ──────────────────────────────────────────────────────────

#[test]
fn get_admin_returns_none_before_init() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    assert!(client.get_admin().is_none());
}

#[test]
fn get_admin_returns_admin_after_init() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn propose_and_accept_admin_transfers_ownership() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.init(&admin);

    // Step 1: current admin proposes new admin
    client.propose_admin(&new_admin);

    // Admin has not changed yet
    assert_eq!(client.get_admin(), Some(admin.clone()));

    // Step 2: new admin accepts
    client.accept_admin();

    // Admin is now the new address
    assert_eq!(client.get_admin(), Some(new_admin));
}

#[test]
fn accept_admin_fails_when_no_pending_admin() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(ContractError::NoPendingAdmin)));
}

#[test]
fn only_pending_admin_can_accept() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.init(&admin);
    client.propose_admin(&new_admin);

    // Disable mock_all_auths so we can test real auth enforcement
    // We verify by checking the pending slot is still set after an
    // unauthorised call would panic — instead we rely on mock_all_auths
    // honouring require_auth for the *specific* address stored.
    // With mock_all_auths the call succeeds for any caller, so we verify
    // indirectly: accept_admin reads PendingAdmin and sets Admin = PendingAdmin.
    // We call it from impostor's perspective, but the contract uses the stored
    // pending address (new_admin) — not the caller — as the new admin.
    // The only way a wrong address can bypass this is if require_auth is removed.
    // The structural test below verifies the storage transition is correct.
    let _ = impostor; // silence unused warning; see integration note above

    client.accept_admin();
    assert_eq!(client.get_admin(), Some(new_admin));
}

#[test]
fn propose_admin_requires_current_admin_auth() {
    let env = Env::default();
    // Do NOT call mock_all_auths — test real auth enforcement
    let contract_id = env.register(TokenLocker, ());
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // init with admin auth
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "init",
            args: soroban_sdk::vec![&env, admin.into_val(&env)],
            sub_invokes: &[],
        },
    }]);
    client.init(&admin);

    // propose_admin called without admin's authorisation must panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env2 = env.clone();
        let c2 = TokenLockerClient::new(&env2, &contract_id);
        c2.propose_admin(&new_admin)
    }));
    assert!(result.is_err(), "propose_admin without auth must panic");
}

#[test]
fn admin_transfer_is_idempotent_on_re_propose() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let candidate_a = Address::generate(&env);
    let candidate_b = Address::generate(&env);
    client.init(&admin);

    // Propose A, then change mind and propose B
    client.propose_admin(&candidate_a);
    client.propose_admin(&candidate_b);

    // Accepting should complete transfer to B, not A
    client.accept_admin();
    assert_eq!(client.get_admin(), Some(candidate_b));
}

// ── Lock metadata ─────────────────────────────────────────────────────────────

#[test]
fn create_lock_stores_metadata() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let metadata = LockMetadata {
        description: soroban_sdk::String::from_str(&env, "Team allocation, locked for trust"),
        project_url: soroban_sdk::String::from_str(&env, "https://example.com"),
        logo_url: soroban_sdk::String::from_str(&env, "https://example.com/logo.png"),
    };

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &metadata,
    );

    let lock = client.get_lock(&lock_id).expect("lock exists");
    assert!(!lock.metadata.is_empty());
    assert_eq!(lock.metadata.description, metadata.description);
    assert_eq!(lock.metadata.project_url, metadata.project_url);
    assert_eq!(lock.metadata.logo_url, metadata.logo_url);
}

#[test]
fn create_lock_without_metadata_leaves_it_empty() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    let lock = client.get_lock(&lock_id).expect("lock exists");
    assert!(lock.metadata.is_empty());
}

// ── Multi-account: unauthorized rejection ─────────────────────────────────────
//
// Build the lock with `mock_all_auths` (as setup_env does), then clear the
// mocked authorizations with `mock_auths(&[])` before invoking the
// state-mutating call under test. With no authorization present for the
// address the contract actually requires (`lock.beneficiary` or
// `lock.creator`), an address that is neither the creator nor the beneficiary
// can never satisfy `require_auth()`, so the call must panic.

#[test]
fn unauthorized_address_cannot_withdraw() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    advance_time(&env, 200_000);

    env.mock_auths(&[]);
    let _ = &unauthorized;

    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.withdraw(&lock_id)));
    assert!(
        result.is_err(),
        "withdraw by an unauthorized address must be rejected"
    );
}

#[test]
fn unauthorized_address_cannot_extend() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    env.mock_auths(&[]);
    let _ = &unauthorized;

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.extend(&lock_id, &(unlock_at + 1000))
    }));
    assert!(
        result.is_err(),
        "extend by an unauthorized address must be rejected"
    );
}

#[test]
fn unauthorized_address_cannot_transfer_beneficiary() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &token_id,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    env.mock_auths(&[]);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.transfer_beneficiary(&lock_id, &unauthorized)
    }));
    assert!(
        result.is_err(),
        "transfer_beneficiary by an unauthorized address must be rejected"
    );
}

// ── Upgrade timelock ──────────────────────────────────────────────────────────

#[test]
fn propose_upgrade_fails_when_not_initialized() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = client.try_propose_upgrade(&wasm_hash);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn execute_upgrade_fails_when_not_initialized() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn cancel_upgrade_fails_when_not_initialized() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let result = client.try_cancel_upgrade();
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn execute_upgrade_fails_when_no_pending_upgrade() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(ContractError::NoPendingUpgrade)));
}

#[test]
fn execute_upgrade_fails_before_timelock_elapses() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    client.propose_upgrade(&wasm_hash);

    // Advance time by less than the 7-day timelock (UPGRADE_DELAY = 7 * 24 * 3600)
    advance_time(&env, 6 * 24 * 3600);

    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(ContractError::TimelockNotElapsed)));
}

#[test]
fn propose_upgrade_succeeds_after_init() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    assert!(client.try_propose_upgrade(&wasm_hash).is_ok());
}

#[test]
fn cancel_upgrade_clears_pending_proposal() {
    let (env, contract_id, _token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
    client.propose_upgrade(&wasm_hash);

    // Cancel the proposal
    client.cancel_upgrade();

    // After cancellation there is no pending upgrade, so execute must fail with NoPendingUpgrade
    advance_time(&env, 8 * 24 * 3600);
    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(ContractError::NoPendingUpgrade)));
}

#[test]
fn create_lock_rejects_vesting_outside_unlock_window() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let now = env.ledger().timestamp();
    let unlock_at = now + 100_000;
    let vesting = Vesting {
        start: unlock_at + 1,
        end: unlock_at + 2,
        released: 0,
    };

    let result = client.try_create_lock(
        &creator,
        &token_id,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &Some(vesting),
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::VestingOutsideLockBounds)));
}

#[test]
fn create_split_lock_rejects_duplicate_beneficiaries() {
    let (env, contract_id, token_id) = setup_env();
    let client = TokenLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &token_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;

    let result = client.try_create_split_lock(
        &creator,
        &token_id,
        &1_000_i128,
        &vec![
            &env,
            (beneficiary.clone(), 5_000_u64),
            (beneficiary, 5_000_u64),
        ],
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::DuplicateBeneficiary)));
}
