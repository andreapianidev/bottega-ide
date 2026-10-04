# Sourced by package.sh. WidgetKit keeps its extension process alive independently
# of the containing app. Replacing the bundle without retiring that process makes
# chronod reject every new timeline with "Bundle version did not match".
stop_installed_bottega_widget() {
  local pattern='^/Applications/Bottega[.]app/Contents/Resources/app/extensions/bottega-home/nucleo/Bottega Nucleo[.]app/Contents/PlugIns/BottegaWidget[.]appex/Contents/MacOS/BottegaWidget( |$)'
  pgrep -f "$pattern" >/dev/null || return 0
  pkill -TERM -f "$pattern" 2>/dev/null || true
  # WidgetKit normally suspends its extension between requests. Resume it so TERM
  # can be delivered before replacing the executable it has mapped in memory.
  pkill -CONT -f "$pattern" 2>/dev/null || true
  local attempt
  for attempt in {1..5}; do
    pgrep -f "$pattern" >/dev/null || return 0
    sleep 1
  done
  pkill -KILL -f "$pattern" 2>/dev/null || true
  for attempt in {1..5}; do
    pgrep -f "$pattern" >/dev/null || return 0
    sleep 1
  done
  echo "Il vecchio widget Bottega non si è fermato; installazione interrotta." >&2
  return 1
}
