"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import CreateEventModal from "./CreateEventModal";
import EditEventModal from "./EditEventModal";
import { Modal } from "@/components/ui/Modal";
import { orangeAccentIcon } from "@/lib/glass";
import { card, ink, body, tile, btnPrimary } from "@/lib/theme-v2/theme";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  description: string | null;
  location?: string | null;
}

export type CalendarEventCreationState =
  | "available"
  | "account_suspended"
  | "bookings_paused"
  | "state_unavailable";

interface CalendarViewProps {
  isConnected: boolean;
  googleEmail: string | null;
  eventCreationState?: CalendarEventCreationState;
  /** Dev-only demo mode (/demo routes): seed events and skip the Google
   *  Calendar fetch entirely. Real dashboard callers never pass this. */
  demoEvents?: CalendarEvent[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getDaysInMonthGrid(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = firstDay.getDay();
  const days: Date[] = [];

  for (let i = startOffset - 1; i >= 0; i--) {
    days.push(new Date(year, month, -i));
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }

  while (days.length < 42) {
    const next = days.length - startOffset - lastDay.getDate() + 1;
    days.push(new Date(year, month + 1, next));
  }

  return days;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString([], { month: "long", year: "numeric" });
}

export default function CalendarView({
  isConnected: initialConnected,
  googleEmail,
  eventCreationState = "available",
  demoEvents,
}: CalendarViewProps) {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [events, setEvents] = useState<CalendarEvent[]>(demoEvents ?? []);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(initialConnected);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [runtimeEventCreationState, setRuntimeEventCreationState] = useState(
    eventCreationState
  );
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);
  const [viewEvent, setViewEvent] = useState<CalendarEvent | null>(null);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);

  async function handleDeleteEvent() {
    if (!deleteEventId || !deleteOperationId) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams({
        eventId: deleteEventId,
        operationId: deleteOperationId,
      });
      const res = await fetch(`/api/calendar/events?${params.toString()}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchEvents();
        setDeleteEventId(null);
        setDeleteOperationId(null);
      } else if (res.status === 409) {
        // The prior identity is definitively conflicted; a new deliberate
        // attempt may use a fresh UUID. Retryable/ambiguous failures retain
        // the exact ID so provider reconciliation can converge safely.
        setDeleteOperationId(globalThis.crypto.randomUUID());
      }
    } catch {
      // Handle silently
    } finally {
      setDeleting(false);
    }
  }

  const fetchEvents = useCallback(async () => {
    if (demoEvents) return;
    if (!connected) return;
    setLoading(true);
    try {
      const start = new Date(
        currentMonth.getFullYear(),
        currentMonth.getMonth(),
        1
      ).toISOString();
      const end = new Date(
        currentMonth.getFullYear(),
        currentMonth.getMonth() + 1,
        1
      ).toISOString();

      const res = await fetch(
        `/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
      const data = await res.json();

      if (data.connected === false) {
        setConnected(false);
        setEvents([]);
      } else {
        setEvents(data.events ?? []);
      }
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [currentMonth, connected, demoEvents]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    setRuntimeEventCreationState(eventCreationState);
    if (eventCreationState !== "available") setCreateModalOpen(false);
  }, [eventCreationState]);

  const days = getDaysInMonthGrid(
    currentMonth.getFullYear(),
    currentMonth.getMonth()
  );

  function getEventsForDate(date: Date): CalendarEvent[] {
    return events.filter((e) => {
      const eventDate = new Date(e.start);
      return isSameDay(eventDate, date);
    });
  }

  function hasEvents(date: Date): boolean {
    return getEventsForDate(date).length > 0;
  }

  const selectedEvents = getEventsForDate(selectedDate);
  const canCreateEvents = runtimeEventCreationState === "available";
  const creationUnavailableLead =
    runtimeEventCreationState === "account_suspended"
      ? "New event creation is unavailable while your account is suspended."
      : runtimeEventCreationState === "bookings_paused"
        ? "New event creation is paused."
        : runtimeEventCreationState === "state_unavailable"
          ? "New event creation is temporarily unavailable while we check booking status."
          : null;
  const creationUnavailableCopy = creationUnavailableLead
    ? `${creationUnavailableLead} ${
        connected
          ? "Existing events can still be viewed, edited, or deleted."
          : "You can still connect or manage Google Calendar in Settings."
      }`
    : null;
  const creationUnavailableNotice = creationUnavailableCopy ? (
    <div
      role="status"
      className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100"
    >
      {creationUnavailableCopy}
    </div>
  ) : null;

  function handleEventCreationUnavailable(
    state: Exclude<CalendarEventCreationState, "available">
  ) {
    setRuntimeEventCreationState(state);
    setCreateModalOpen(false);
  }

  function goToPrevMonth() {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
    );
  }

  function goToNextMonth() {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
    );
  }

  function goToToday() {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(now);
  }

  // Not connected state
  if (!connected) {
    return (
      <div className="space-y-4">
        {creationUnavailableNotice}
        <div className={`p-10 text-center ${card}`}>
          <div
            className={`w-16 h-16 mx-auto mb-4 grid place-items-center ${orangeAccentIcon}`}
          >
            <CalendarDays className="w-8 h-8 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
          </div>
          <h3 className={`text-lg font-bold mb-2 ${ink}`}>
            Connect your Google Calendar
          </h3>
          <p className={`mb-6 max-w-md mx-auto ${body}`}>
            Link your Google Calendar to see your appointments and bookings here.
            Go to Settings and enable Direct Scheduling to connect.
            {googleEmail && (
              <span className="block mt-1 text-sm">
                Previously connected: {googleEmail}
              </span>
            )}
          </p>
          <a
            href="/settings"
            className={`${btnPrimary} w-auto px-8`}
          >
            Go to Settings
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-5 sm:p-6 ${card}`}>
      {creationUnavailableNotice && (
        <div className="mb-5">{creationUnavailableNotice}</div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Calendar grid */}
        <div className="lg:col-span-2">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <button
                onClick={goToPrevMonth}
                className={`w-9 h-9 grid place-items-center rounded-xl border border-[#e7e0d4] dark:border-white/[0.10] hover:bg-[#faf6ef] dark:hover:bg-white/[0.06] transition-colors ${body}`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={goToNextMonth}
                className={`w-9 h-9 grid place-items-center rounded-xl border border-[#e7e0d4] dark:border-white/[0.10] hover:bg-[#faf6ef] dark:hover:bg-white/[0.06] transition-colors ${body}`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <h2 className={`text-lg font-bold ml-2 ${ink}`}>
                {formatMonthYear(currentMonth)}
              </h2>
            </div>
            <button
              onClick={goToToday}
              className={`text-sm font-medium px-3 py-1.5 rounded-full border border-[#e7e0d4] dark:border-white/[0.10] hover:bg-[#faf6ef] dark:hover:bg-white/[0.06] transition-colors ${body}`}
            >
              Today
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAY_LABELS.map((day) => (
              <div
                key={day}
                className={`text-center text-xs font-medium uppercase tracking-wider py-2 ${body}`}
              >
                {day}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {days.map((date, i) => {
              const isCurrentMonth =
                date.getMonth() === currentMonth.getMonth();
              const isToday = isSameDay(date, today);
              const isSelected = isSameDay(date, selectedDate);
              const dateHasEvents = hasEvents(date);

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(date)}
                  className={`
                    aspect-square p-1 flex flex-col items-center justify-center gap-1
                    rounded-xl transition-all text-sm relative
                    ${!isCurrentMonth ? "opacity-35" : ""}
                    ${isSelected ? "bg-[rgb(var(--brand-primary-rgb)/.12)] border border-[var(--brand-primary)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.18)] dark:border-[var(--brand-primary-dark)]" : "border border-transparent hover:bg-[#faf6ef] dark:hover:bg-white/[0.06]"}
                    ${isToday && !isSelected ? "bg-[rgb(var(--brand-primary-rgb)/.07)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.08)]" : ""}
                  `}
                >
                  <span
                    className={`
                      w-7 h-7 grid place-items-center rounded-full font-medium
                      ${
                        isToday
                          ? "bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)] text-white font-bold"
                          : dateHasEvents
                            ? "text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] font-semibold"
                            : ink
                      }
                    `}
                  >
                    {date.getDate()}
                  </span>
                  {dateHasEvents && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)] absolute bottom-1.5" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Loading overlay */}
          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-[var(--brand-primary)] dark:text-[var(--brand-primary-dark)] animate-spin" />
                <span className={`text-sm ${body}`}>
                  Loading events...
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right: Day detail panel */}
        <div className="lg:col-span-1">
          <div className={`p-4 ${tile} h-full`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-sm font-bold ${ink}`}>
                {formatFullDate(selectedDate)}
              </h3>
              <button
                onClick={() => setCreateModalOpen(true)}
                disabled={!canCreateEvents}
                aria-label="Create event"
                className="w-7 h-7 grid place-items-center rounded-lg bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] dark:bg-[var(--brand-primary-dark)] dark:hover:bg-[var(--brand-primary-hover-dark)] text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  canCreateEvents
                    ? "Create event"
                    : "New event creation is unavailable"
                }
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {selectedEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <CalendarDays className="w-8 h-8 mb-2 text-stone-300 dark:text-white/[0.15]" />
                <p className={`text-sm ${body}`}>
                  No events scheduled
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {selectedEvents.map((event) => (
                  <div
                    key={event.id}
                    onClick={() => setViewEvent(event)}
                    className="
                      p-3.5 rounded-[22px] cursor-pointer
                      border border-[var(--brand-calendar-border)] dark:border-white/[0.10]
                      bg-[var(--brand-calendar-wash)] dark:bg-white/[0.04]
                      border-l-[3px] border-l-[var(--brand-primary)] dark:border-l-[var(--brand-primary-dark)]
                      hover:border-[var(--brand-calendar-muted)] dark:hover:border-white/[0.16] transition-colors
                    "
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Clock className="w-3.5 h-3.5 text-[var(--brand-accent)] dark:text-[var(--brand-primary-soft-dark)]" />
                      <span className="text-xs font-medium text-[var(--brand-primary-active)] dark:text-[var(--brand-calendar-accent)]">
                        {event.allDay
                          ? "All day"
                          : `${formatTime(event.start)} – ${formatTime(event.end)}`}
                      </span>
                    </div>
                    <p className={`text-sm font-semibold ${ink}`}>
                      {event.title}
                    </p>
                    {event.description && (
                      <p
                        className={`text-xs mt-1 line-clamp-2 text-stone-600 dark:text-[#c8c8cc]`}
                      >
                        {event.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {canCreateEvents && (
        <CreateEventModal
          open={createModalOpen}
          onClose={() => setCreateModalOpen(false)}
          selectedDate={selectedDate}
          onEventCreated={fetchEvents}
          onCreationUnavailable={handleEventCreationUnavailable}
        />
      )}

      <EditEventModal
        open={!!editEvent}
        onClose={() => setEditEvent(null)}
        event={editEvent}
        onEventUpdated={fetchEvents}
      />

      {/* Event Detail Modal */}
      <Modal
        open={!!viewEvent}
        onClose={() => setViewEvent(null)}
        title={viewEvent?.title || ""}
        description={formatFullDate(selectedDate)}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Clock className={`w-4 h-4 ${body}`} />
            <span className={`text-sm font-medium ${ink}`}>
              {viewEvent?.allDay
                ? "All day"
                : viewEvent
                  ? `${formatTime(viewEvent.start)} – ${formatTime(viewEvent.end)}`
                  : ""}
            </span>
          </div>

          {viewEvent?.location ? <p className={`text-sm ${ink}`}>Location: {viewEvent.location}</p> : null}
          {viewEvent?.description && (
            <div>
              <p className={`text-xs font-medium uppercase mb-1 ${body}`}>Description</p>
              <p className={`text-sm whitespace-pre-wrap ${ink}`}>
                {viewEvent.description}
              </p>
            </div>
          )}

          <div className="pt-2 border-t border-[#ece4d8] dark:border-white/[0.10] flex items-center justify-between">
            <button
              onClick={() => {
                setEditEvent(viewEvent);
                setViewEvent(null);
              }}
              className="flex items-center gap-2 text-sm text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)] transition-colors"
            >
              <Pencil className="w-4 h-4" />
              Edit Event
            </button>
            <button
              onClick={() => {
                setDeleteEventId(viewEvent?.id || null);
                setDeleteOperationId(globalThis.crypto.randomUUID());
                setViewEvent(null);
              }}
              className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Delete Event
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={!!deleteEventId}
        onClose={() => {
          setDeleteEventId(null);
          setDeleteOperationId(null);
        }}
        title="Delete Event"
        description="Are you sure? This will remove the event from your Google Calendar and notify any attendees."
      >
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => {
              setDeleteEventId(null);
              setDeleteOperationId(null);
            }}
            disabled={deleting}
            className="flex-1 rounded-full border border-[#e7e0d4] dark:border-white/[0.12] px-4 py-2.5 text-sm font-medium text-stone-700 dark:text-[#bdbdbf] hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDeleteEvent}
            disabled={deleting}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full bg-red-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {deleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
