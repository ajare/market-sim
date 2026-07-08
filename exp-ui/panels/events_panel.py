import re

from imgui_bundle import imgui

from app import Panel
from sim_state import SimState

_DAY_PREFIX_RE = re.compile(r"^Day\s*(\d+)\s*\|\s*(.*)$")
_DAY_ANYWHERE_RE = re.compile(r"Day\s+(\d+)")

# Checked in order -- every pattern more specific than the generic "EVENT"
# agent-event catch-all must come BEFORE it, since a daily market-price line
# can itself carry a "[EVENT] Some Event Name" suffix (see Market.simulate_day
# / World.run's verbose printing) that would otherwise also match \bEVENT\b.
# A pirate raid also shows up as an "EVENT" line on the VICTIM's side (see
# PirateBrigade._attack, which logs a "kind": "cash_loss" agent_event_log
# entry named "Pirate attack by ..." on the victim, printed with the same
# "EVENT" keyword World uses for genuine random AgentEvents) -- caught here
# by that literal name so it's still labeled "Attack" (matching the
# attacker's own ATTACK trade_log line) rather than lumped in with actual
# AgentEvents (delay/cargo_loss/cash_gain/cash_loss/fuel_discount/
# fixed_cost_discount).
_EVENT_TYPE_PATTERNS = [
    (re.compile(r"\bBUY\b"), "Buy"),
    (re.compile(r"\bSELL\b"), "Sell"),
    (re.compile(r"\bREFUEL\b"), "Refuel"),
    (re.compile(r"\bATTACK\b"), "Attack"),
    (re.compile(r"Pirate attack by"), "Attack"),
    (re.compile(r"\bMOVE\b"), "Move"),
    (re.compile(r"PORT CLOSURE"), "Port Closure"),
    (re.compile(r"has reopened"), "Reopened"),
    (re.compile(r"GLOBAL COMMODITY EVENT"), "Global Event"),
    (re.compile(r"LOCATION-WIDE EVENT"), "Location Event"),
    (re.compile(r"WORLDWIDE EVENT"), "Worldwide Event"),
    (re.compile(r"\| Price:"), "Market"),
    (re.compile(r"\bEVENT\b"), "Agent Event"),
]

# Trade/repositioning/raid/agent-event lines all share World's
# "{name:<10}{ACTION...}" prefix -- the name isn't reliably fixed-width
# (longer names overflow the padding), so pull it out by anchoring on the
# known action keyword that follows it instead of a column count.
_NAME_BEFORE_ACTION_RE = re.compile(r"^(.*?)\s+(?:BUY|SELL|REFUEL|ATTACK|MOVE|EVENT)\b")
_LOCATION_BEFORE_COMMA_RE = re.compile(r"@\s*(.+?),")
_LOCATION_BEFORE_COMMA_STRIP_RE = re.compile(r"\s*@\s*.+?,")
_LOCATION_BEFORE_AFFECTING_RE = re.compile(r"@\s*(.+?)\s+affecting")
_REOPENED_LOCATION_RE = re.compile(r"Day\s+\d+:\s*(.+?)\s+has reopened")

_CAPTAIN_SUBJECT_TYPES = frozenset({"Buy", "Sell", "Refuel", "Attack", "Move", "Agent Event"})
_GLOBAL_SUBJECT_TYPES = frozenset({"Global Event", "Worldwide Event"})

# Every type a row can be classified as, EXCEPT "Market" -- that one's
# always hidden outright (see EventsPanel.render), never offered as a
# filter choice, so it's left out of this list entirely.
FILTERABLE_EVENT_TYPES = [
    "Buy", "Sell", "Move", "Refuel", "Attack", "Agent Event",
    "Global Event", "Location Event", "Worldwide Event", "Port Closure", "Reopened",
]


def _event_subject(message: str, event_type: str) -> str:
    """Who/where a log line is about: the Captain's name for trade/
    repositioning/refuel/raid/agent-event lines (all keyed off a Transport),
    the Location's name for a Market price line, a port closure/reopening,
    or a location-wide event, and "Global" for a commodity-wide or
    worldwide event that isn't tied to any single location. Falls back to
    "" if the message doesn't match the expected shape for its type."""
    if event_type in _CAPTAIN_SUBJECT_TYPES:
        match = _NAME_BEFORE_ACTION_RE.match(message)
        return match.group(1).strip() if match else ""
    if event_type == "Market":
        return message.split("|", 1)[0].strip()
    if event_type == "Port Closure":
        match = _LOCATION_BEFORE_COMMA_RE.search(message)
        return match.group(1).strip() if match else ""
    if event_type == "Reopened":
        match = _REOPENED_LOCATION_RE.search(message)
        return match.group(1).strip() if match else ""
    if event_type == "Location Event":
        match = _LOCATION_BEFORE_AFFECTING_RE.search(message)
        return match.group(1).strip() if match else ""
    if event_type in _GLOBAL_SUBJECT_TYPES:
        return "Global"
    return ""


def _strip_subject(message: str, event_type: str) -> str:
    """The message with whatever _event_subject already pulled out of it
    removed, since it's now shown separately in its own column and would
    otherwise just be repeated. "Global" (Global/Worldwide events) is left
    alone -- it's a synthetic label, not literal text taken out of the
    message. Falls back to the original message unchanged if it doesn't
    match the expected shape for its type."""
    if event_type in _CAPTAIN_SUBJECT_TYPES:
        match = _NAME_BEFORE_ACTION_RE.match(message)
        return message[match.end(1):].lstrip() if match else message
    if event_type == "Market":
        _, _, rest = message.partition("|")
        return rest.strip() if rest else message
    if event_type == "Port Closure":
        return _LOCATION_BEFORE_COMMA_STRIP_RE.sub(",", message, count=1)
    if event_type == "Reopened":
        return re.sub(r"(Day\s+\d+:)\s*.+?\s+has reopened", r"\1 has reopened", message, count=1)
    if event_type == "Location Event":
        return re.sub(r"@\s*.+?\s+affecting", "affecting", message, count=1)
    return message


def _split_day(line: str) -> tuple[str, str]:
    """Pulls the day number out of a captured console line (see
    SimState.step, which captures World's own verbose print output) so it
    can be its own table column instead of repeated inline text on every
    row. Most lines are "Day NNN | rest of message"; a few (event/closure
    announcements) instead read "*** Day NNN: ... ***" -- day still
    extracted, but the asterisks stay as part of the message. Falls back
    to an empty day column for anything that matches neither shape."""
    match = _DAY_PREFIX_RE.match(line)
    if match:
        return match.group(1), match.group(2)
    match = _DAY_ANYWHERE_RE.search(line)
    if match:
        return match.group(1), line
    return "", line


def _event_type(message: str) -> str:
    """Classifies a log line's message (day prefix already stripped) into a
    short type label -- BUY/SELL trades become "Buy"/"Sell" specifically,
    per request, with every other kind of line World's verbose output
    produces (repositioning, refueling, raids, market-wide/location-wide/
    global/worldwide events, port closures, and the daily per-market price
    line) getting its own label too. Falls back to "" for anything that
    doesn't match a known shape."""
    for pattern, label in _EVENT_TYPE_PATTERNS:
        if pattern.search(message):
            return label
    return ""


class EventsPanel(Panel):
    title = "Event Log"

    def __init__(self, state: SimState):
        self.state = state
        self.selected_types: set[str] = set(FILTERABLE_EVENT_TYPES)
        self.subject_filter: str = ""

    def _render_type_filter(self) -> None:
        all_selected = len(self.selected_types) == len(FILTERABLE_EVENT_TYPES)
        label = "Event Types (All)" if all_selected else f"Event Types ({len(self.selected_types)})"
        if imgui.button(label):
            imgui.open_popup("event_type_filter_popup")

        if imgui.begin_popup("event_type_filter_popup"):
            if imgui.small_button("All"):
                self.selected_types = set(FILTERABLE_EVENT_TYPES)
            imgui.same_line()
            if imgui.small_button("None"):
                self.selected_types = set()
            imgui.separator()
            for event_type in FILTERABLE_EVENT_TYPES:
                checked = event_type in self.selected_types
                changed, checked = imgui.checkbox(event_type, checked)
                if changed:
                    if checked:
                        self.selected_types.add(event_type)
                    else:
                        self.selected_types.discard(event_type)
            imgui.end_popup()

    def render(self) -> None:
        self._render_type_filter()
        imgui.same_line()
        imgui.set_next_item_width(160.0)
        _, self.subject_filter = imgui.input_text("Subject filter", self.subject_filter)

        flags = (
            imgui.TableFlags_.borders | imgui.TableFlags_.row_bg
            | imgui.TableFlags_.resizable | imgui.TableFlags_.scroll_y
        )
        if not imgui.begin_table("event_log_table", 4, flags):
            return
        imgui.table_setup_column("Day", imgui.TableColumnFlags_.width_fixed, 50.0)
        imgui.table_setup_column("Event Type", imgui.TableColumnFlags_.width_fixed, 110.0)
        imgui.table_setup_column("Subject", imgui.TableColumnFlags_.width_fixed, 140.0)
        imgui.table_setup_column("Message")
        imgui.table_setup_scroll_freeze(0, 1)
        imgui.table_headers_row()

        for line in self.state.log_lines:
            day, message = _split_day(line)
            event_type = _event_type(message)
            if event_type == "Market":
                # The daily per-(location, commodity, side) price/demand/
                # supply line World prints for every market, every day --
                # far too high-volume to read alongside the narrative
                # (trades, repositioning, raids, closures, events). Always
                # hidden outright, never offered as a filter choice.
                continue
            if event_type not in self.selected_types:
                continue
            subject = _event_subject(message, event_type)
            if self.subject_filter.strip() and self.subject_filter.lower() not in subject.lower():
                continue
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(day)
            imgui.table_next_column()
            imgui.text(event_type)
            imgui.table_next_column()
            imgui.text(subject)
            imgui.table_next_column()
            imgui.text_unformatted(_strip_subject(message, event_type))

        if imgui.get_scroll_y() >= imgui.get_scroll_max_y():
            imgui.set_scroll_here_y(1.0)
        imgui.end_table()
