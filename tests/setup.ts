// Disable the cmd/codex auth probe in the test process so computeLadder()/LADDER stay
// deterministic and spawn-free. Real probing only happens in the live server.
process.env.WORKER_SKIP_AUTH_GATE = '1';
