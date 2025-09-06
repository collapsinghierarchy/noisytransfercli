# scripts/rtc-gdb.sh
#!/usr/bin/env bash
set -euo pipefail
ENTRY="${1:-./build/pkg.cjs}"
MODE="${2:-recv}"
shift 2 || true
ARGS=("$@")

cat > /tmp/gdbcmds.txt <<'EOF'
set pagination off
run
bt
thread apply all bt
info sharedlibrary
quit
EOF
echo "Running: gdb -q -x /tmp/gdbcmds.txt --args node $ENTRY $MODE ${ARGS[*]}"
NT_DEBUG=1 gdb -q -x /tmp/gdbcmds.txt --args node "$ENTRY" "$MODE" "${ARGS[@]}"
