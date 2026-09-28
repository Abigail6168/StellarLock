use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, Address, Env, IntoVal, Symbol, TryFromVal,
};

use crate::{ContractError, Dex, LockMetadata, LpLocker, LpLockerClient, Vesting};

// ── Test setup ────────────────────────────────────────────────────────────────

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Start far enough past t=0 that the first lock clears the 60s rate limit.
    env.ledger().with_mut(|l| l.timestamp = 1_000);

    let contract_id = env.register(LpLocker, ());

    let admin = Address::generate(&env);
    let pool_share_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);

    (env, contract_id, pool_share_id, token_a, token_b)
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
fn create_lp_lock_valid_inputs() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &500_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    let lock = client.get_lock(&lock_id).expect("lock exists");
    assert_eq!(lock.amount, 500_i128);
    assert_eq!(lock.creator, creator);
    assert_eq!(lock.beneficiary, beneficiary);
    assert_eq!(lock.unlock_at, unlock_at);
    assert!(!lock.withdrawn);
}

#[test]
fn create_lp_lock_rejects_zero_amount() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &0_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::AmountMustBePositive)));
}

#[test]
fn create_lp_lock_rejects_past_unlock() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &0_u64,
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(result, Err(Ok(ContractError::UnlockMustBeFuture)));
}

// ── Multi-account: withdraw authorization ─────────────────────────────────────

#[test]
fn beneficiary_can_withdraw_after_unlock() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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

// ── Multi-account: extend authorization ──────────────────────────────────────

#[test]
fn creator_can_extend_lp_lock() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    let result = client.try_extend(&lock_id, &(unlock_at - 1));
    assert_eq!(result, Err(Ok(ContractError::CanOnlyExtend)));
}

#[test]
fn extend_after_withdrawal_fails() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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

#[test]
fn withdraw_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let result = client.try_withdraw(&999_999);
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

#[test]
fn extend_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let result = client.try_extend(&999_999, &(env.ledger().timestamp() + 100_000));
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

#[test]
fn transfer_beneficiary_on_missing_lock_returns_lock_not_found() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let new_beneficiary = Address::generate(&env);
    let result = client.try_transfer_beneficiary(&999_999, &new_beneficiary);
    assert_eq!(
        result,
        Err(Ok(ContractError::LockNotFound)),
        "expected LockNotFound typed error, not a panic"
    );
}

// ── Multi-account: beneficiary transfer flow ──────────────────────────────────

#[test]
fn transfer_beneficiary_and_new_beneficiary_can_withdraw() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let original_beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &300_i128,
        &original_beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    client.transfer_beneficiary(&lock_id, &new_beneficiary);

    let lock = client.get_lock(&lock_id).unwrap();
    assert_eq!(lock.beneficiary, new_beneficiary);

    advance_time(&env, 200_000);
    client.withdraw(&lock_id);

    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn transfer_beneficiary_updates_indexes() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let original_beneficiary = Address::generate(&env);
    let new_beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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

// ── Creator / beneficiary index query tests ───────────────────────────────────

#[test]
fn get_locks_by_creator_returns_correct_locks() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator_a, 5_000);
    mint(&env, &pool_share_id, &creator_b, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let id1 = client.create_lock(
        &creator_a,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    let id2 = client.create_lock(
        &creator_a,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &200_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );
    client.create_lock(
        &creator_b,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &300_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );

    let locks_a = client.get_locks_by_creator(&creator_a, &0, &10);
    assert_eq!(locks_a.len(), 2);
    let ids: soroban_sdk::Vec<u64> = {
        let mut v = soroban_sdk::vec![&env];
        for l in locks_a.iter() {
            v.push_back(l.id);
        }
        v
    };
    assert!(ids.contains(id1));
    assert!(ids.contains(id2));

    assert_eq!(client.get_locks_by_creator(&creator_b, &0, &10).len(), 1);
}

// ── ByPoolShare index tests ───────────────────────────────────────────────────

#[test]
fn get_locks_by_pool_share_works() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let id1 = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &200_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    let id2 = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &300_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );

    let locks = client.get_locks_by_pool_share(&pool_share_id, &0, &10);
    assert_eq!(locks.len(), 2);

    let ids: soroban_sdk::Vec<u64> = {
        let mut v = soroban_sdk::vec![&env];
        for l in locks.iter() {
            v.push_back(l.id);
        }
        v
    };
    assert!(ids.contains(id1));
    assert!(ids.contains(id2));
}

#[test]
fn different_pool_shares_have_isolated_indexes() {
    let (env, contract_id, pool_share_a, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin2 = Address::generate(&env);
    let pool_share_b = env.register_stellar_asset_contract_v2(admin2).address();

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_a, &creator, 5_000);
    mint(&env, &pool_share_b, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &pool_share_a,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    client.create_lock(
        &creator,
        &pool_share_b,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &200_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );

    assert_eq!(client.get_lock_count_by_pool_share(&pool_share_a), 1);
    assert_eq!(client.get_lock_count_by_pool_share(&pool_share_b), 1);
}

// ── TVL / global stats ────────────────────────────────────────────────────────

#[test]
fn lp_tvl_increases_on_create_decreases_on_withdraw() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id_1 = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &400_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &600_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );

    assert_eq!(client.get_total_locked(&pool_share_id), 1_000_i128);

    let stats = client.get_global_stats();
    assert_eq!(stats.total_lock_count, 2);
    assert_eq!(stats.unique_pool_share_count, 1);

    // Total elapsed at this point is 61s; advance past lock_id_1's unlock_at (+100_000s from start).
    advance_time(&env, 100_000);
    client.withdraw(&lock_id_1);

    assert_eq!(client.get_total_locked(&pool_share_id), 600_i128);
}

#[test]
fn lp_global_stats_counts_unique_pool_shares() {
    let (env, contract_id, pool_share_a, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin2 = Address::generate(&env);
    let pool_share_b = env.register_stellar_asset_contract_v2(admin2).address();

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_a, &creator, 5_000);
    mint(&env, &pool_share_b, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &pool_share_a,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    client.create_lock(
        &creator,
        &pool_share_b,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &200_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );

    let stats = client.get_global_stats();
    assert_eq!(stats.total_lock_count, 2);
    assert_eq!(stats.unique_pool_share_count, 2);
}

// ── create_lock TVL overflow guard (#490) ────────────────────────────────────

#[test]
fn create_lock_returns_typed_error_on_tvl_overflow() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &crate::DataKey::TotalLocked(pool_share_id.clone()),
            &(i128::MAX - 1),
        );
    });

    let unlock_at = env.ledger().timestamp() + 100_000;
    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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

#[test]
fn create_lock_near_overflow_boundary_succeeds() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &crate::DataKey::TotalLocked(pool_share_id.clone()),
            &(i128::MAX - 100),
        );
    });

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    assert_eq!(client.get_total_locked(&pool_share_id), i128::MAX);
}

// ── Cross-account query isolation ─────────────────────────────────────────────

#[test]
fn three_accounts_full_lp_flow() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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

// ── Admin management ──────────────────────────────────────────────────────────

#[test]
fn get_admin_returns_none_before_init() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    assert!(client.get_admin().is_none());
}

#[test]
fn get_admin_returns_admin_after_init() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn propose_and_accept_admin_transfers_ownership() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.init(&admin);

    client.propose_admin(&new_admin);
    assert_eq!(client.get_admin(), Some(admin.clone()));

    client.accept_admin();
    assert_eq!(client.get_admin(), Some(new_admin));
}

#[test]
fn accept_admin_fails_when_no_pending_admin() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(ContractError::NoPendingAdmin)));
}

#[test]
fn admin_transfer_is_idempotent_on_re_propose() {
    let (env, contract_id, _pool_share_id, _token_a, _token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let candidate_a = Address::generate(&env);
    let candidate_b = Address::generate(&env);
    client.init(&admin);

    client.propose_admin(&candidate_a);
    client.propose_admin(&candidate_b);

    client.accept_admin();
    assert_eq!(client.get_admin(), Some(candidate_b));
}

#[test]
fn propose_admin_requires_current_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(LpLocker, ());
    let client = LpLockerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

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

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let env2 = env.clone();
        let c2 = LpLockerClient::new(&env2, &contract_id);
        c2.propose_admin(&new_admin)
    }));
    assert!(result.is_err(), "propose_admin without auth must panic");
}

// ── Lock metadata ─────────────────────────────────────────────────────────────

#[test]
fn create_lock_stores_metadata() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let metadata = LockMetadata {
        description: soroban_sdk::String::from_str(&env, "Aquarius liquidity, locked"),
        project_url: soroban_sdk::String::from_str(&env, "https://example.com"),
        logo_url: soroban_sdk::String::from_str(&env, "https://example.com/logo.png"),
    };

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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

#[test]
fn unauthorized_address_cannot_withdraw() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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

// ── Vesting ───────────────────────────────────────────────────────────────────

#[test]
fn vesting_end_must_be_after_start() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let now = env.ledger().timestamp();
    let bad_vesting = Vesting {
        start: now + 1_000,
        end: now + 500, // end before start — invalid
        released: 0,
    };

    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now,
        end: now + 200_000,
        released: 0,
    };

    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(vesting),
        &empty_metadata(&env),
    );

    // Advance to 50 % of the vesting window (which also clears unlock_at) —
    // only half should be releasable.
    advance_time(&env, 100_000);
    client.withdraw(&lock_id);

    // Lock must NOT be marked fully withdrawn after a partial release.
    assert!(!client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn full_vesting_marks_withdrawn() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now,
        end: now + 1_000,
        released: 0,
    };

    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000),
        &Some(vesting),
        &empty_metadata(&env),
    );

    // Advance past both unlock_at and the end of the vesting window —
    // everything should be releasable.
    advance_time(&env, 150_000);
    client.withdraw(&lock_id);

    assert!(client.get_lock(&lock_id).unwrap().withdrawn);
}

#[test]
fn vesting_proportional_release_at_midpoint() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let now = env.ledger().timestamp();
    let vesting_duration = 200_000_u64;
    let vesting = Vesting {
        start: now,
        end: now + vesting_duration,
        released: 0,
    };

    let lock_id = client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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
        "expected 50 % released at midpoint"
    );
    assert!(
        !lock.withdrawn,
        "lock should not be fully withdrawn at midpoint"
    );
}

#[test]
fn vesting_nothing_to_release_before_start() {
    // Vesting starts in the future. Even after unlock_at passes, nothing is
    // releasable yet because the vesting clock hasn't started.
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now + 150_000, // vesting hasn't begun yet
        end: now + 250_000,
        released: 0,
    };

    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &beneficiary,
        &(now + 100_000), // unlock_at is before vesting start
        &Some(vesting),
        &empty_metadata(&env),
    );

    assert_eq!(result, Err(Ok(ContractError::VestingOutsideLockBounds)));
}

#[test]
fn split_lock_with_vesting_allocates_and_vests_correctly() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let now = env.ledger().timestamp();
    let vesting = Vesting {
        start: now,
        end: now + 200_000,
        released: 0,
    };

    let unlock_at = now + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &10_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at,
        &Some(vesting),
    );

    let group = client.get_split_group(&group_id).unwrap();
    assert_eq!(group.lock_ids.len(), 2);

    // Each sub-lock must carry the vesting schedule.
    let lock0 = client.get_lock(&group_id).unwrap();
    assert_eq!(lock0.amount, 7_000_i128);
    assert!(!lock0.vesting.is_none());
    assert_eq!(lock0.vesting.released, 0);

    let lock1_id = group.lock_ids.get(1).unwrap();
    let lock1 = client.get_lock(&lock1_id).unwrap();
    assert_eq!(lock1.amount, 3_000_i128);
    assert!(!lock1.vesting.is_none());

    // Advance to midpoint (which also clears unlock_at) — b1 should get
    // 50 % of their 7 000 share.
    advance_time(&env, 100_000);
    client.withdraw(&group_id);

    let lock0_after = client.get_lock(&group_id).unwrap();
    assert_eq!(lock0_after.vesting.released, 3_500_i128);
    assert!(!lock0_after.withdrawn);
}

#[test]
fn split_lock_vesting_end_before_start_is_rejected() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let now = env.ledger().timestamp();
    let bad_vesting = Vesting {
        start: now + 1_000,
        end: now + 100,
        released: 0,
    };

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &10_000_i128,
        &soroban_sdk::vec![&env, (b1, 5_000_u64), (b2, 5_000_u64)],
        &(now + 100_000),
        &Some(bad_vesting),
    );
    assert_eq!(result, Err(Ok(ContractError::VestingEndBeforeStart)));
}

// ── Rate limiting (#203) ──────────────────────────────────────────────────────

#[test]
fn create_lock_rate_limit_rejects_rapid_second_call() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;

    // First call must succeed.
    client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );

    // Immediate second call from the same creator must be rejected.
    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::RateLimitExceeded)),
        "expected RateLimitExceeded on rapid second create_lock"
    );

    // After the cooldown (RATE_LIMIT_COOLDOWN = 60s) a third call must succeed.
    advance_time(&env, 61);
    client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &(env.ledger().timestamp() + 100_000),
        &None,
        &empty_metadata(&env),
    );
}

#[test]
fn create_lock_rate_limit_is_per_creator() {
    // Two different creators must not interfere with each other's cooldowns.
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator_a, 5_000);
    mint(&env, &pool_share_id, &creator_b, 5_000);

    let unlock_at = env.ledger().timestamp() + 100_000;

    client.create_lock(
        &creator_a,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    // creator_b hasn't locked yet so this must succeed immediately.
    client.create_lock(
        &creator_b,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &100_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
}

// ── Split lock rate-limit tests ────────────────────────────────────────────────

#[test]
fn create_split_lock_two_beneficiaries_correct_amounts() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &10_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 6_000_u64), (b2.clone(), 4_000_u64)],
        &unlock_at,
        &None,
    );

    let group = client.get_split_group(&group_id).expect("group exists");
    assert_eq!(group.group_id, group_id);
    assert_eq!(group.lock_ids.len(), 2);

    let lock_a = client.get_lock(&group_id).expect("first sub-lock exists");
    assert_eq!(lock_a.amount, 6_000_i128);
    assert_eq!(lock_a.beneficiary, b1);
    assert_eq!(lock_a.unlock_at, unlock_at);
    assert!(!lock_a.withdrawn);

    let lock_b = client
        .get_lock(&group.lock_ids.get(1).unwrap())
        .expect("second sub-lock");
    assert_eq!(lock_b.amount, 4_000_i128);
    assert_eq!(lock_b.beneficiary, b2);
}

#[test]
fn create_split_lock_three_way_amounts() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let b3 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 9_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &9_000_i128,
        &soroban_sdk::vec![
            &env,
            (b1.clone(), 5_000_u64),
            (b2.clone(), 3_000_u64),
            (b3.clone(), 2_000_u64),
        ],
        &unlock_at,
        &None,
    );

    let group = client.get_split_group(&group_id).unwrap();
    assert_eq!(group.lock_ids.len(), 3);

    let amounts: soroban_sdk::Vec<i128> = {
        let mut v = soroban_sdk::vec![&env];
        for lid in group.lock_ids.iter() {
            v.push_back(client.get_lock(&lid).unwrap().amount);
        }
        v
    };
    assert_eq!(amounts.get(0).unwrap(), 4_500_i128); // 50 %
    assert_eq!(amounts.get(1).unwrap(), 2_700_i128); // 30 %
    assert_eq!(amounts.get(2).unwrap(), 1_800_i128); // 20 %
}

// ── create_split_lock: input validation ───────────────────────────────────────

#[test]
fn create_split_lock_rejects_zero_amount() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &0_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::AmountMustBePositive)));
}

#[test]
fn create_split_lock_rejects_past_unlock_at() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &0_u64,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::UnlockMustBeFuture)));
}

#[test]
fn create_split_lock_rejects_single_beneficiary() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 10_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::TooFewBeneficiaries)));
}

#[test]
fn create_split_lock_rejects_bps_not_10000() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 4_000_u64), (b2.clone(), 4_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::SharesMustSum10000)));
}

// ── create_split_lock: index population ───────────────────────────────────────

#[test]
fn split_lock_sub_locks_appear_in_beneficiary_index() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 7_000_u64), (b2.clone(), 3_000_u64)],
        &unlock_at,
        &None,
    );

    assert_eq!(client.get_lock_count_by_beneficiary(&b1), 1);
    assert_eq!(client.get_lock_count_by_beneficiary(&b2), 1);
    assert_eq!(
        client
            .get_locks_by_beneficiary(&b1, &0, &10)
            .get(0)
            .unwrap()
            .amount,
        700_i128
    );
}

#[test]
fn split_lock_sub_locks_in_creator_and_pool_share_indexes() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 2_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &2_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &unlock_at,
        &None,
    );

    assert_eq!(client.get_lock_count_by_creator(&creator), 2);
    assert_eq!(client.get_lock_count_by_pool_share(&pool_share_id), 2);
}

#[test]
fn get_split_groups_by_creator_returns_group() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 6_000_u64), (b2.clone(), 4_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );

    let groups = client.get_split_groups_by_creator(&creator, &0, &10);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups.get(0).unwrap().group_id, group_id);
}

#[test]
fn get_split_groups_by_creator_pagination_works() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let _unlock_at = env.ledger().timestamp() + 100_000;
    for _ in 0..3_u32 {
        client.create_split_lock(
            &creator,
            &pool_share_id,
            &Dex::Soroswap,
            &token_a,
            &token_b,
            &1_000_i128,
            &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
            &(env.ledger().timestamp() + 100_000),
            &None,
        );
        advance_time(&env, 61);
    }

    assert_eq!(
        client.get_split_groups_by_creator(&creator, &0, &10).len(),
        3
    );
    assert_eq!(
        client.get_split_groups_by_creator(&creator, &1, &1).len(),
        1
    );
    assert_eq!(
        client.get_split_groups_by_creator(&creator, &3, &10).len(),
        0
    );
}

// ── create_split_lock: TVL and global stats ───────────────────────────────────

#[test]
fn split_lock_tvl_and_global_stats() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 5_000);

    client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &4_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );

    assert_eq!(client.get_total_locked(&pool_share_id), 4_000_i128);
    let stats = client.get_global_stats();
    assert_eq!(stats.total_lock_count, 2);
    assert_eq!(stats.unique_pool_share_count, 1);
}

#[test]
fn split_lock_tvl_adds_to_existing_regular_lock() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 10_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    client.create_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &3_000_i128,
        &beneficiary,
        &unlock_at,
        &None,
        &empty_metadata(&env),
    );
    advance_time(&env, 61);
    client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &2_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );

    assert_eq!(client.get_total_locked(&pool_share_id), 5_000_i128);
    let stats = client.get_global_stats();
    // 1 regular + 2 split sub-locks = 3
    assert_eq!(stats.total_lock_count, 3);
}

// ── create_split_lock: withdrawal behaviour ───────────────────────────────────

#[test]
fn split_lock_beneficiaries_withdraw_independently() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let unlock_at = env.ledger().timestamp() + 100_000;
    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 6_000_u64), (b2.clone(), 4_000_u64)],
        &unlock_at,
        &None,
    );

    let group = client.get_split_group(&group_id).unwrap();
    let id_b2 = group.lock_ids.get(1).unwrap();

    advance_time(&env, 200_000);

    client.withdraw(&group_id);
    assert!(client.get_lock(&group_id).unwrap().withdrawn);
    assert!(!client.get_lock(&id_b2).unwrap().withdrawn);

    client.withdraw(&id_b2);
    assert!(client.get_lock(&id_b2).unwrap().withdrawn);
}

#[test]
fn split_lock_sub_lock_still_locked_before_unlock() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);

    let group_id = client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Soroswap,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1.clone(), 5_000_u64), (b2.clone(), 5_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );

    let result = client.try_withdraw(&group_id);
    assert_eq!(result, Err(Ok(ContractError::StillLocked)));
}

#[test]
fn create_lock_rejects_vesting_outside_unlock_window() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);
    let now = env.ledger().timestamp();
    let unlock_at = now + 100_000;
    let vesting = Vesting {
        start: unlock_at + 1,
        end: unlock_at + 2,
        released: 0,
    };

    let result = client.try_create_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
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
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);
    let unlock_at = env.ledger().timestamp() + 100_000;

    let result = client.try_create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![
            &env,
            (beneficiary.clone(), 5_000_u64),
            (beneficiary, 5_000_u64),
        ],
        &unlock_at,
        &None,
    );
    assert_eq!(result, Err(Ok(ContractError::DuplicateBeneficiary)));
}

#[test]
fn create_split_lock_emits_an_lp_lock_created_event_per_child() {
    let (env, contract_id, pool_share_id, token_a, token_b) = setup_env();
    let client = LpLockerClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    mint(&env, &pool_share_id, &creator, 1_000);
    client.create_split_lock(
        &creator,
        &pool_share_id,
        &Dex::Aquarius,
        &token_a,
        &token_b,
        &1_000_i128,
        &soroban_sdk::vec![&env, (b1, 5_000_u64), (b2, 5_000_u64)],
        &(env.ledger().timestamp() + 100_000),
        &None,
    );

    let child_events = env
        .events()
        .all()
        .iter()
        .filter(|(address, topics, _)| {
            *address == contract_id
                && Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap()
                    == Symbol::new(&env, "lp_lock_created")
        })
        .count();
    assert_eq!(child_events, 2);
}
