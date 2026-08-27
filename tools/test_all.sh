#!/bin/sh
# The complete test suite in one call.
#
#   sh tools/test_all.sh            check
#   sh tools/test_all.sh --accept   set the golden files to the current state
#
# The golden files pin down the generated gcode line by line. Every difference
# is shown; intended changes are taken over with --accept after reading the diff.

set -e
cd "$(dirname "$0")/.."
ACCEPT=0
[ "$1" = "--accept" ] && ACCEPT=1

VORON="References/avent_mount_0.4n_0.2mm_ABS_voron_1h52m.gcode"
CORE="tools/fixtures/coreone_min.gcode"
TMP="${TMPDIR:-/tmp}/pa_test_$$"
mkdir -p "$TMP" tools/golden
trap 'rm -rf "$TMP"' EXIT

# References/ holds the sliced sample prints, 19 MB of them, and is not in the
# repository. Everything that needs a real slicer file is then skipped instead
# of failing -- loudly and counted, so a green run never hides a gap.
SAMPLES=1
[ -f "$VORON" ] || SAMPLES=0
skipped=0
skip() { skipped=$((skipped+1)); echo "  skipped      $1 (no sample files under References/)"; }

# name|source|arguments
CASES="
voron_frame_5_num|$VORON|0 0.08 0.005 frame 5 1
voron_layer_2_nonum|$VORON|0.02 0.06 0.01 layer 2 0
voron_none_9_num|$VORON|0 0.3 0.02 none 9 1
coreone_frame_5_num|$CORE|0 0.054 0.002 frame 5 1
coreone_frame_3_nonum|$CORE|0 0.1 0.01 frame 3 0
voron_fine_0001|$VORON|0.02 0.025 0.0001 frame 5 1
voron_default|$VORON|0.025 0.08 0.0025 frame 5 1
"

fail=0

# Compare the generated file against the checked-in golden file. Must run in the
# current shell so that fail is really set; a pipeline would be a subshell.
compare_golden() {
  new="$TMP/$1.$2"; old="tools/golden/$1.$2"
  if [ "$ACCEPT" = "1" ]; then
    cp "$new" "$old"
    echo "  accepted     $1"
  elif [ ! -f "$old" ]; then
    echo "  MISSING      $1  (create with --accept)"
    fail=1
  elif diff -q "$old" "$new" >/dev/null; then
    echo "  same         $1"
  else
    echo "  DIFFERS      $1"
    diff -u "$old" "$new" | head -"$3"
    fail=1
  fi
}

echo "== 1) Golden Files =="
if [ "$SAMPLES" = "0" ]; then skip "section 1"; else
echo "$CASES" | while IFS='|' read -r name src args; do
  [ -z "$name" ] && continue
  node tools/gen.mjs "$src" "$TMP/$name.gcode" $args >/dev/null
done
for g in $(echo "$CASES" | awk -F'|' 'NF{print $1}'); do compare_golden "$g" gcode 40; done
fi
echo "== 2) Extrusion multiplier: fingerprints =="
if [ "$SAMPLES" = "0" ]; then skip "section 2"; else
# The whole plate, 56 plates from 0.850 to 1.125; the tool does the selection,
# so every case carries its range.
EM_VORON="References/em_neu_Extrusion_Multipliers_0.4n_0.3mm_PLA_Voron 0.4mm CHT_4h31m.gcode"
EM_CORE="References/em_neu_Extrusion_Multipliers_0.4n_0.25mm_PLA_COREONE_3h34m.bgcode"
# name|source|rename (empty = none)|from|to
EM_CASES="
em_voron|$EM_VORON|||
em_coreone|$EM_CORE|||
em_voron_mid|$EM_VORON||0.950|1.000
em_coreone_mid|$EM_CORE||0.950|1.000
em_voron_one|$EM_VORON||1.125|1.125
em_coreone_low|$EM_CORE||0.850|0.900
em_voron_em095|$EM_VORON|; extrusion_multiplier = 1:; extrusion_multiplier = 0.95||
em_voron_prefix|$EM_VORON|'0_965':'EM_Cube_0_965_stl'||
"
echo "$EM_CASES" | while IFS='|' read -r name src ren lo hi; do
  [ -z "$name" ] && continue
  node tools/em_digest.mjs "$src" "$TMP/$name.gcode" "$TMP/$name.txt" "$ren" "$lo" "$hi" >/dev/null
done
for g in $(echo "$EM_CASES" | awk -F'|' 'NF{print $1}'); do compare_golden "$g" txt 30; done
fi

echo "== 2b) Temperature tower: fingerprints =="
if [ "$SAMPLES" = "0" ]; then skip "section 2b"; else
TT_VORON="References/10mm_temperature_tower_0.4n_0.3mm_PLA_Voron 0.4mm CHT_2h24m.gcode"
TT_CORE="References/10mm_temperature_tower_0.4n_0.25mm_PLA_COREONE_2h20m.bgcode"
# name|source|from|to
TT_CASES="
tt_voron_full|$TT_VORON|180|280
tt_voron_mid|$TT_VORON|220|240
tt_voron_top|$TT_VORON|270|280
tt_coreone_full|$TT_CORE|180|280
tt_coreone_mid|$TT_CORE|220|240
tt_coreone_low|$TT_CORE|180|195
"
echo "$TT_CASES" | while IFS='|' read -r name src from to; do
  [ -z "$name" ] && continue
  node tools/tt_digest.mjs "$src" "$TMP/$name.gcode" "$TMP/$name.txt" "$from" "$to" >/dev/null
done
for g in $(echo "$TT_CASES" | awk -F'|' 'NF{print $1}'); do compare_golden "$g" txt 30; done
fi

[ "$ACCEPT" = "1" ] && { echo "Golden files set."; exit 0; }

echo
echo "== 3) check_gcode.py on the golden files =="
for g in tools/golden/*.gcode; do
  if python3 tools/check_gcode.py "$g" >"$TMP/chk.txt" 2>&1; then
    echo "  ok           $(basename "$g")  $(grep '^Summary' "$TMP/chk.txt")"
  else
    echo "  FAILED       $(basename "$g")"
    grep -E '^FAIL' "$TMP/chk.txt" | head -5
    fail=1
  fi
done

echo
echo "== 4) Shared constants =="
python3 - <<'PYEOF' || fail=1
import io, re
# JS and Python share markers without knowing about each other - reconcile here.
gen = io.open('js/pa/generator.js', encoding='utf-8').read()
chk = io.open('tools/check_gcode.py', encoding='utf-8').read()
pv  = io.open('js/pa/preview.js', encoding='utf-8').read()
bad = 0
for name in ('BODY_BEGIN', 'BODY_END'):
    a = re.search(r"const %s\s*=\s*'([^']+)'" % name, gen)
    b = re.search(r'%s = "([^"]+)"' % name, chk)
    if not a or not b or a.group(1) != b.group(1):
        print('  DIFFERS     %s: js=%r py=%r' % (name, a and a.group(1), b and b.group(1)))
        bad += 1
tags_js = set(re.search(r'CAT_RE = /\\b\(([^)]+)\)', pv).group(1).split('|'))
tags_py = set(re.findall(r'"(\w+)"', re.search(r'MARKERS = \(([^)]+)\)', chk).group(1)))
if tags_js != tags_py:
    print('  DIFFERS     markers: js=%s py=%s' % (sorted(tags_js), sorted(tags_py)))
    bad += 1
if not bad:
    print('  ok           markers and sentinels agree between js/ and tools/')
raise SystemExit(1 if bad else 0)
PYEOF

echo
echo "== 5) Thumbnail and QOI tests =="
if node tools/test_thumbnail.mjs >"$TMP/th.txt" 2>&1; then
  echo "  ok           $(tail -1 "$TMP/th.txt")"
else
  echo "  FAILED"; grep FAIL "$TMP/th.txt" | head -5; fail=1
fi

echo
echo "== 6) Extrusion multiplier unit cases =="
if node tools/test_em.mjs >"$TMP/em_unit.txt" 2>&1; then
  echo "  ok           $(tail -1 "$TMP/em_unit.txt")"
else
  echo "  FAILED"; grep '^FAIL' "$TMP/em_unit.txt" | head -5; fail=1
fi

echo
echo "== 6b) Temperature tower unit cases =="
if node tools/test_tt.mjs >"$TMP/tt_unit.txt" 2>&1; then
  echo "  ok           $(tail -1 "$TMP/tt_unit.txt")"
else
  echo "  FAILED"; grep '^FAIL' "$TMP/tt_unit.txt" | head -5; fail=1
fi

echo
echo "== 7) check_em.py: output against input =="
if [ "$SAMPLES" = "0" ]; then skip "section 7"; else
# The checker expects ASCII, so the bgcode source is unpacked once; the renamed
# cases get the same rename as during generation.
node -e "
import('./tools/bgcode.mjs').then(async m => {
  const fs = await import('node:fs');
  fs.writeFileSync('$TMP/em_coreone_in.gcode', await m.readGcodeText('$EM_CORE'));
  const v = fs.readFileSync('$EM_VORON', 'utf8');
  fs.writeFileSync('$TMP/em_voron_em095_in.gcode',
    v.split('; extrusion_multiplier = 1').join('; extrusion_multiplier = 0.95'));
  fs.writeFileSync('$TMP/em_voron_prefix_in.gcode',
    v.split(\"'0_965'\").join(\"'EM_Cube_0_965_stl'\"));
});"
for pair in "em_voron|$EM_VORON" "em_coreone|$TMP/em_coreone_in.gcode" \
            "em_voron_mid|$EM_VORON" "em_coreone_mid|$TMP/em_coreone_in.gcode" \
            "em_voron_one|$EM_VORON" "em_coreone_low|$TMP/em_coreone_in.gcode" \
            "em_voron_em095|$TMP/em_voron_em095_in.gcode" \
            "em_voron_prefix|$TMP/em_voron_prefix_in.gcode"; do
  name=${pair%%|*}; src=${pair#*|}
  if python3 tools/check_em.py "$src" "$TMP/$name.gcode" >"$TMP/ce.txt" 2>&1; then
    echo "  ok           $name  $(grep '^Summary' "$TMP/ce.txt")"
  else
    echo "  FAILED       $name"
    grep -E '^FAIL' "$TMP/ce.txt" | head -5
    fail=1
  fi
done

echo
fi
echo "== 7b) check_tt.py: output against input =="
if [ "$SAMPLES" = "0" ]; then skip "section 7b"; else
# The checker expects ASCII; the bgcode source is unpacked once.
node -e "
import('./tools/bgcode.mjs').then(async m => {
  const fs = await import('node:fs');
  fs.writeFileSync('$TMP/tt_coreone_in.gcode', await m.readGcodeText('$TT_CORE'));
});"
for pair in "tt_voron_full|$TT_VORON" "tt_voron_mid|$TT_VORON" "tt_voron_top|$TT_VORON" \
            "tt_coreone_full|$TMP/tt_coreone_in.gcode" "tt_coreone_mid|$TMP/tt_coreone_in.gcode" \
            "tt_coreone_low|$TMP/tt_coreone_in.gcode"; do
  name=${pair%%|*}; src=${pair#*|}
  if python3 tools/check_tt.py "$src" "$TMP/$name.gcode" >"$TMP/ct.txt" 2>&1; then
    echo "  ok           $name  $(grep '^Summary' "$TMP/ct.txt")"
  else
    echo "  FAILED       $name"
    grep -E '^FAIL' "$TMP/ct.txt" | head -5
    fail=1
  fi
done

echo
fi
echo "== 8) Sweep over every pattern variant =="
if [ "$SAMPLES" = "0" ]; then skip "section 8"; else
n=0; bad=0
for src in "$VORON" "$CORE"; do
  tag=$(basename "$src" | cut -c1-6)
  for anchor in frame layer none; do
    for num in 1 0; do
      for layers in 2 5 9; do
        for range in "0 0.08 0.005" "0 0.1 0.002" "0.02 0.06 0.01" "0 0.3 0.02"; do
          n=$((n+1))
          out="$TMP/sweep.gcode"
          if ! node tools/gen.mjs "$src" "$out" $range $anchor $layers $num >/dev/null 2>&1; then
            echo "  GEN FAILED   $tag $anchor $num $layers $range"; bad=$((bad+1)); continue
          fi
          if ! python3 tools/check_gcode.py "$out" >/dev/null 2>&1; then
            echo "  CHECK FAILED $tag $anchor $num $layers $range"; bad=$((bad+1))
          fi
        done
      done
    done
  done
done
echo "  $n files, $bad failures"
[ "$bad" != "0" ] && fail=1

echo
fi
echo "== 8b) Sweep over every temperature range =="
if [ "$SAMPLES" = "0" ]; then skip "section 8b"; else
node -e "
import('./tools/bgcode.mjs').then(async m => {
  const fs = await import('node:fs');
  fs.writeFileSync('$TMP/tt_coreone_in.gcode', await m.readGcodeText('$TT_CORE'));
});"
tn=0; tbad=0
for pair in "$TT_VORON|$TT_VORON" "$TT_CORE|$TMP/tt_coreone_in.gcode"; do
  src=${pair%%|*}; ref=${pair#*|}
  for from in 180 195 220 245 280; do
    for span in 0 10 40; do
      to=$((from + span))
      [ "$to" -gt 280 ] && continue
      tn=$((tn+1))
      out="$TMP/tt_sweep.gcode"
      if ! node tools/gen_tt.mjs "$src" "$out" "$from" "$to" >/dev/null 2>&1; then
        echo "  GEN FAILED   $(basename "$src" | cut -c1-20) $from-$to"; tbad=$((tbad+1)); continue
      fi
      if ! python3 tools/check_tt.py "$ref" "$out" >/dev/null 2>&1; then
        echo "  CHECK FAILED $(basename "$src" | cut -c1-20) $from-$to"; tbad=$((tbad+1))
      fi
    done
  done
done
echo "  $tn ranges, $tbad failures"
[ "$tbad" != "0" ] && fail=1

echo
echo
fi
if [ "$fail" != "0" ]; then echo "FAILED - see above"
elif [ "$skipped" = "0" ]; then echo "ALL GREEN"
else echo "ALL GREEN, but $skipped section(s) skipped for want of sample files"; fi
exit $fail
