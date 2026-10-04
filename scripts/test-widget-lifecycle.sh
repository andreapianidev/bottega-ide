#!/bin/zsh
# No real processes/signals: check installation lifecycle with shell command doubles.
set -euo pipefail
ROOT=${0:A:h:h}
source "$ROOT/scripts/widget-lifecycle.sh"
typeset -a signals
typeset -i alive suspended stubborn immortal pauses
pgrep() { (( alive )); }
pkill() {
  [[ $2 == -f && $3 == '^/Applications/Bottega[.]app/'*'/BottegaWidget( |$)' ]] || return 99
  signals+=("$1")
  case $1 in
    -TERM) (( suspended || stubborn )) || alive=0 ;;
    -CONT) suspended=0; (( stubborn )) || alive=0 ;;
    -KILL) (( immortal )) || alive=0 ;;
  esac
  return 0
}
sleep() { (( pauses += 1 )); }

alive=0 suspended=0 stubborn=0 immortal=0 pauses=0 signals=()
stop_installed_bottega_widget
(( ${#signals} == 0 && pauses == 0 ))

alive=1 suspended=1 stubborn=0 immortal=0 pauses=0 signals=()
stop_installed_bottega_widget
[[ ${(j:,:)signals} == '-TERM,-CONT' ]] && (( alive == 0 && pauses == 0 ))

alive=1 suspended=0 stubborn=1 immortal=0 pauses=0 signals=()
stop_installed_bottega_widget
[[ ${(j:,:)signals} == '-TERM,-CONT,-KILL' ]] && (( alive == 0 && pauses == 5 ))

alive=1 suspended=0 stubborn=1 immortal=1 pauses=0 signals=()
if stop_installed_bottega_widget 2>/dev/null; then
  echo 'FAIL: install must stop when extension cannot be retired' >&2
  exit 1
fi
(( alive == 1 && pauses == 10 ))

# Ensure the exact pattern cannot stop another widget, a development copy, or the app.
pattern='^/Applications/Bottega[.]app/Contents/Resources/app/extensions/bottega-home/nucleo/Bottega Nucleo[.]app/Contents/PlugIns/BottegaWidget[.]appex/Contents/MacOS/BottegaWidget( |$)'
installed='/Applications/Bottega.app/Contents/Resources/app/extensions/bottega-home/nucleo/Bottega Nucleo.app/Contents/PlugIns/BottegaWidget.appex/Contents/MacOS/BottegaWidget'
[[ "$installed -BSServiceDomains {}" =~ $pattern ]]
[[ ! "/tmp$installed" =~ $pattern ]]
[[ ! "${installed}Other" =~ $pattern ]]
[[ ! '/Applications/Bottega.app/Contents/MacOS/Bottega' =~ $pattern ]]
echo 'Widget lifecycle: suspended, missing, stubborn, failure and exact scope PASS'
