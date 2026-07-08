import re

from imgui_bundle import imgui

from app import Panel
from sim.state import SimState

_DAY_PREFIX_RE = re.compile(r"^Day\s*(\d+)\s*\|\s*(.*)$")

# Trade/repositioning-log lines only -- every random shock (global/location/
# worldwide/local MarketEvents, AgentEvents, LocationClosures) now comes
# structured off SimState.events (real Event objects, see sim/events.py)
# instead of being reconstructed by regex from World's printed console
# output, so this table is just for classifying the remaining BUY/SELL/
# REFUEL/ATTACK/MOVE lines, which don't have an Event/dataclass equivalent
# (yet -- there's no Trade class) and still only exist as console text.
_TRADE_TYPE_PATTERNS = [
    (re.compile(r"\bBUY\b"), "Buy"),
    (re.compile(r"\bSELL\b"), "Sell"),
    (re.compile(r"\bREFUEL\b"), "Refuel"),
    (re.compile(r"\bATTACK\b"), "Attack"),
    (re.compile(r"\bMOVE\b"), "Move"),
]

# Trade/repositioning/raid lines all share World's "{name:<10}{ACTION...}"
# prefix -- the name isn't reliably fixed-width (longer names overflow the
# padding), so pull it out by anchoring on the known action keyword that
# follows it instead of a column count.
_NAME_BEFORE_ACTION_RE = re.compile(r"^(.*?)\s+(?:BUY|SELL|REFUEL|ATTACK|MOVE)\b")

# Event.type (see sim/events.py's Event base class) -> the label this panel
# shows/filters by.
_EVENT_TYPE_LABELS = {
    "Global": "Global Event",
    "Location": "Location Event",
    "Worldwide": "Worldwide Event",
    "Local": "Local Event",
    "Agent": "Agent Event",
    "Closure": "Port Closure",
}

FILTERABLE_EVENT_TYPES = [
    "Buy", "Sell", "Move", "Refuel", "Attack",
    "Global Event", "Location Event", "Worldwide Event", "Local Event",
    "Agent Event", "Port Closure",
]


def _trade_subject(message: str) -> str:
    """The Captain's name a trade/repositioning/raid log line is about --
    falls back to "" if the message doesn't match the expected shape."""
    match = _NAME_BEFORE_ACTION_RE.match(message)
    return match.group(1).strip() if match else ""


def _strip_subject(message: str) -> str:
    """The message with whatever _trade_subject already pulled out of it
    removed, since it's now shown separately in its own column and would
    otherwise just be repeated. Falls back to the original message
    unchanged if it doesn't match the expected shape."""
    match = _NAME_BEFORE_ACTION_RE.match(message)
    return message[match.end(1):].lstrip() if match else message


def _split_day(line: str) -> tuple[int, str]:
    """Pulls the day number out of a captured console line (see
    SimState.step, which captures World's own verbose print output) so it
    can be its own table column instead of repeated inline text on every
    row. Falls back to day 0 for anything that doesn't match "Day NNN | ..."
    (shouldn't happen for the BUY/SELL/REFUEL/ATTACK/MOVE lines this is
    used for, which are always printed with that prefix)."""
    match = _DAY_PREFIX_RE.match(line)
    if match:
        return int(match.group(1)), match.group(2)
    return 0, line


def _trade_type(message: str) -> str:
    """Classifies a trade/repositioning-log line's message (day prefix
    already stripped) into a short type label. Falls back to "" for
    anything that doesn't match a known shape (e.g. the daily per-market
    price line, which this panel never shows)."""
    for pattern, label in _TRADE_TYPE_PATTERNS:
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

    def _rows(self):
        """Every row this panel can show, sorted by day: trade/
        repositioning lines parsed from the console log (no structured
        equivalent exists yet), plus every Event SimState has recorded,
        already fully structured -- see sim/events.py's Event and
        SimState.events."""
        rows = []
        for line in self.state.log_lines:
            day, message = _split_day(line)
            trade_type = _trade_type(message)
            if not trade_type:
                continue
            rows.append((day, trade_type, _trade_subject(message), _strip_subject(message)))
        for event in self.state.events:
            event_type = _EVENT_TYPE_LABELS.get(event.type, event.type)
            rows.append((event.day or 0, event_type, event.subject, event.message))
        rows.sort(key=lambda row: row[0])
        return rows

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

        for day, event_type, subject, message in self._rows():
            if event_type not in self.selected_types:
                continue
            if self.subject_filter.strip() and self.subject_filter.lower() not in subject.lower():
                continue
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(str(day))
            imgui.table_next_column()
            imgui.text(event_type)
            imgui.table_next_column()
            imgui.text(subject)
            imgui.table_next_column()
            imgui.text_unformatted(message)

        if imgui.get_scroll_y() >= imgui.get_scroll_max_y():
            imgui.set_scroll_here_y(1.0)
        imgui.end_table()
