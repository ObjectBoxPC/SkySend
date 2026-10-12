#!/usr/bin/env bash
# Shapes the loopback traffic of transfer.mjs, so a run on one machine meets a real network:
# the hop from the browser to the server (proxy A, port BASE) and the hop from the server to the
# bucket (proxy B, port BASE+2) each get their own rate and delay. Nothing else on the machine is
# touched, other traffic keeps the bands of the default priomap. Needs root.
#
#   sudo e2e/bench/shape.sh apply <client rate> <client delay> <s3 rate> <s3 delay> [base port]
#   sudo e2e/bench/shape.sh apply 1gbit 5ms 400mbit 15ms
#   sudo e2e/bench/shape.sh clear
#   e2e/bench/shape.sh show
#
# A delay applies to each direction, so 15ms is a round trip of 30 ms, and "15ms 10ms" adds up to
# 10 ms of jitter. A rate of "none" leaves that hop unshaped.
set -euo pipefail

DEV=lo
action=${1:-show}

case "$action" in
  apply)
    client_rate=$2 client_delay=$3 s3_rate=$4 s3_delay=$5 base=${6:-3900}
    tc qdisc del dev "$DEV" root 2>/dev/null || true
    # Bands 1:1 to 1:3 carry everything else exactly as the default priomap would.
    tc qdisc add dev "$DEV" root handle 1: prio bands 5 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
    hop() {
      local band=$1 port=$2 rate=$3 delay=$4
      if [ "$rate" = "none" ]; then return; fi
      # Unquoted on purpose: a delay like "15ms 10ms" adds jitter as a second word.
      # shellcheck disable=SC2086
      tc qdisc add dev "$DEV" parent "1:$band" handle "${band}0:" netem delay $delay rate "$rate" limit 100000
      tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 match ip dport "$port" 0xffff flowid "1:$band"
      tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 match ip sport "$port" 0xffff flowid "1:$band"
    }
    hop 4 "$base" "$client_rate" "$client_delay"
    hop 5 "$((base + 2))" "$s3_rate" "$s3_delay"
    tc qdisc show dev "$DEV"
    ;;
  clear)
    tc qdisc del dev "$DEV" root 2>/dev/null || true
    tc qdisc show dev "$DEV"
    ;;
  show)
    tc qdisc show dev "$DEV"
    tc filter show dev "$DEV" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 apply <client rate> <client delay> <s3 rate> <s3 delay> [base port] | clear | show" >&2
    exit 1
    ;;
esac
