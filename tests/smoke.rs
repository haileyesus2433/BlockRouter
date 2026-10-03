use litesvm::LiteSVM;

#[test]
fn program_loads() {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/blockrouter.so"
    ));
    svm.add_program(blockrouter::id(), bytes).unwrap();

    let account = svm.get_account(&blockrouter::id()).unwrap();
    assert!(account.executable);
}
