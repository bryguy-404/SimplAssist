"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, ArrowUp, ArrowUpRight, BatteryFull, CalendarCheck2,
  Check, ChevronRight, MessageCircle, MoreHorizontal, Pause,
  PhoneMissed, Play, Plus, Signal, Wifi,
} from "lucide-react";
import styles from "./hero-demo.module.css";

/** A clay-like device around the original, scripted conversation demo.
 * The shell stays still as messages and outcome cards change. Reduced motion
 * shows the completed first conversation; the pause control preserves progress.
 */

type Sender = "banner" | "ai" | "customer";
type Message = { from: Sender; text: string };

type Conversation = {
  business: string;
  script: Message[];
  /** Customer shown in the incoming enquiry and booking cards. */
  lead: { name: string };
};

const CONVERSATIONS: Conversation[] = [
  {
    business: "Manny's Plumbing",
    lead: { name: "Sarah M." },
    script: [
      { from: "banner", text: "Missed call from Sarah — new customer" },
      {
        from: "ai",
        text: "Hi Sarah! This is the assistant at Manny's Plumbing — sorry we missed your call. How can we help?",
      },
      { from: "customer", text: "My water heater is leaking. Can someone come out this week?" },
      {
        from: "ai",
        text: "We can help with that! We have Tuesday 9 AM or Wednesday 2 PM — which works better?",
      },
      { from: "customer", text: "Tuesday works!" },
      { from: "ai", text: "You're booked for Tuesday at 9 AM ✅ We'll text you a reminder." },
    ],
  },
  {
    business: "Summit Auto Repair",
    lead: { name: "Mike R." },
    script: [
      { from: "banner", text: "Missed call from Mike — new customer" },
      {
        from: "ai",
        text: "Hi Mike! Summit Auto Repair's assistant here — sorry we missed you. What can we help with?",
      },
      { from: "customer", text: "My check engine light came on. How much is a diagnostic?" },
      {
        from: "ai",
        text: "Diagnostics are $89, applied to the repair if you book with us. Want to bring it in tomorrow morning?",
      },
      { from: "customer", text: "Yeah, 8 AM if you have it." },
      { from: "ai", text: "You're set for 8 AM tomorrow ✅ We'll text a reminder tonight." },
    ],
  },
  {
    business: "GreenScape Lawn Care",
    lead: { name: "Jessica L." },
    script: [
      { from: "banner", text: "New website chat — Jessica, 7:42 PM" },
      { from: "ai", text: "Hi! Thanks for reaching out to GreenScape 🌱 How can we help?" },
      { from: "customer", text: "Do you do weekly mowing? I need someone starting this month." },
      {
        from: "ai",
        text: "We do! We have weekly and biweekly plans. Can we schedule a free quote visit this week?",
      },
      { from: "customer", text: "Thursday afternoon?" },
      { from: "ai", text: "Thursday between 1–4 PM it is ✅ Our team will confirm by text in the morning." },
    ],
  },
];

const OUTCOMES = [
  { source: "Missed call", title: "Job booked", slot: "Tuesday, 9:00 AM", initials: "MP" },
  { source: "Missed call", title: "Job booked", slot: "Tomorrow, 8:00 AM", initials: "SA" },
  { source: "Website chat", title: "Quote scheduled", slot: "Thursday, 1–4 PM", initials: "GL" },
] as const;

function Bubble({ from, children }: { from: Sender; children: React.ReactNode }) {
  return (
    <div className={from === "banner" ? styles.banner : `${styles.bubble} ${from === "customer" ? styles.customer : styles.assistant}`}>
      {children}
    </div>
  );
}

function Enter({ children }: { children: React.ReactNode }) {
  return <div className={styles.messageEnter}><div>{children}</div></div>;
}

function TypingBubble({ from }: { from: "ai" | "customer" }) {
  return (
    <div className={`${styles.bubble} ${styles.typing} ${from === "customer" ? styles.customer : styles.assistant}`} aria-hidden="true">
      <span /><span /><span />
    </div>
  );
}

export function HeroDemo() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visible, setVisible] = useState(0);
  const [typing, setTyping] = useState<"ai" | "customer" | null>(null);
  const [faded, setFaded] = useState(false);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chatWindowRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = chatWindowRef.current;
    if (!el) return;
    let raf = 0;
    const start = performance.now();
    const pin = () => {
      el.scrollTop = el.scrollHeight;
      if (!reduceMotion && performance.now() - start < 650) raf = requestAnimationFrame(pin);
    };
    pin();
    return () => cancelAnimationFrame(raf);
  }, [visible, typing, activeIndex, reduceMotion]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setActiveIndex(0);
      setVisible(CONVERSATIONS[0].script.length);
      setTyping(null);
      setFaded(false);
      return;
    }

    let alive = true;
    let timer = 0;
    // Count only active viewing time, so pausing or switching tabs doesn't
    // skip the conversation. Only one timeout is active at a time.
    const wait = (duration: number) => new Promise<void>((resolve) => {
      let remaining = duration;
      let previous = performance.now();
      const tick = () => {
        if (!alive) return;
        const now = performance.now();
        if (!pausedRef.current && !document.hidden) remaining -= Math.min(now - previous, 120);
        previous = now;
        if (remaining <= 0) resolve();
        else timer = window.setTimeout(tick, 100);
      };
      timer = window.setTimeout(tick, 100);
    });

    async function run() {
      let index = 0;
      while (alive) {
        setActiveIndex(index);
        setVisible(1);
        setTyping(null);
        await wait(100);
        if (!alive) return;
        setFaded(false);
        const script = CONVERSATIONS[index].script;
        for (let i = 1; i < script.length; i++) {
          await wait(500 + Math.min(script[i - 1].text.length * 10, 900));
          if (!alive) return;
          const from = script[i].from as "ai" | "customer";
          setTyping(from);
          await wait(from === "ai" ? 1300 : 1050);
          if (!alive) return;
          setTyping(null);
          setVisible(i + 1);
        }
        await wait(4000);
        if (!alive) return;
        setFaded(true);
        await wait(700);
        if (!alive) return;
        index = (index + 1) % CONVERSATIONS.length;
      }
    }

    void run();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [reduceMotion]);

  const convo = CONVERSATIONS[activeIndex];
  const outcome = OUTCOMES[activeIndex];
  const booked = visible >= convo.script.length;
  const engaged = booked || typing !== null || visible >= 2;
  const SourceIcon = activeIndex === 2 ? MessageCircle : PhoneMissed;

  function togglePause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }

  return (
    <div className={styles.demo} data-paused={paused} data-reduced-motion={reduceMotion} role="group" aria-label="Animated example of an enquiry becoming a booking">
      <div className={styles.scene}>
        <div className={styles.backdrop} aria-hidden="true" />
        <div className={styles.floorShadow} aria-hidden="true" />
        <div className={styles.orbit} aria-hidden="true" />

        <div className={`${styles.notice} ${styles.incoming}`} data-faded={faded}>
          <span className={styles.sourceIcon}><SourceIcon size={20} strokeWidth={1.8} aria-hidden="true" /></span>
          <span><span className={styles.cardEyebrow}>A NEW OPPORTUNITY</span><strong>{outcome.source}</strong><span className={styles.cardDetail}>{convo.lead.name} <span>· just now</span></span></span>
          <ArrowUpRight size={15} className={styles.noticeArrow} aria-hidden="true" />
        </div>

        <div className={styles.phonePosition}>
          <div className={styles.phone}>
            <span className={styles.sideButton} aria-hidden="true" />
            <span className={styles.powerButton} aria-hidden="true" />
            <div className={styles.phoneFace}>
              <div className={styles.screen}>
                <div className={styles.statusBar} aria-hidden="true">
                  <span>{activeIndex === 2 ? "7:42" : "9:41"}</span><span className={styles.speaker} /><span className={styles.statusIcons}><Signal size={12} /><Wifi size={12} /><BatteryFull size={17} /></span>
                </div>
                <div className={styles.chatHeader}>
                  <ArrowLeft size={17} aria-hidden="true" />
                  <div className={styles.businessAvatar} aria-hidden="true">{outcome.initials}</div>
                  <div className={styles.business} data-faded={faded}><strong>{convo.business}</strong><span><i /> Your AI receptionist</span></div>
                  <MoreHorizontal size={19} aria-hidden="true" />
                </div>
                <div className={styles.conversation} data-faded={faded}>
                  <p className={styles.timestamp}>TODAY · {activeIndex === 2 ? "7:42 PM" : "9:41 AM"}</p>
                  <div ref={chatWindowRef} className={styles.messages} role="log" aria-live="off" aria-label="Example customer conversation">
                    <div className={styles.messageStack}>
                      {convo.script.slice(0, visible).map((message, i) => (
                        <Enter key={`${activeIndex}-${i}`}><Bubble from={message.from}>{message.text}</Bubble></Enter>
                      ))}
                      {typing && <Enter><TypingBubble from={typing} /></Enter>}
                    </div>
                  </div>
                  <div className={styles.delivery}>{booked ? <><Check size={11} /><Check size={11} /> Delivered</> : <><span className={styles.activeDot} /> {typing === "ai" ? "SimplAssist is replying…" : "SimplAssist is on it"}</>}</div>
                </div>
                <div className={styles.composer} aria-hidden="true"><Plus size={17} /><span>Message<ArrowUp size={14} /></span></div>
                <div className={styles.homeIndicator} aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.handNote}>
          <span>Busy on the job?</span>
          <span>Let us book the next one.</span>
        </div>

        <div className={`${styles.notice} ${styles.booking}`} data-booked={booked && !faded} aria-hidden={!booked || faded}>
          <div className={styles.bookingTop}><span className={styles.calendarIcon}><CalendarCheck2 size={23} strokeWidth={1.7} aria-hidden="true" /></span><span className={styles.bookingCheck}><Check size={12} strokeWidth={3} aria-hidden="true" /> CONFIRMED</span></div>
          <strong>{outcome.title}<span className={styles.bookingDot}>.</span></strong>
          <span className={styles.bookingSlot}>{outcome.slot}</span>
        </div>
      </div>

      <div className={styles.caption}>
        <div className={styles.journey} aria-label="Demo progress">
          <span data-active={visible > 0}><SourceIcon size={13} aria-hidden="true" />{outcome.source}</span><ChevronRight size={12} aria-hidden="true" />
          <span data-active={engaged}><MessageCircle size={13} aria-hidden="true" />Replied</span><ChevronRight size={12} aria-hidden="true" />
          <span data-active={booked} className={styles.journeyBooked}><Check size={13} aria-hidden="true" />{activeIndex === 2 ? "Quote set" : "Booked"}</span>
        </div>
        <button className={styles.pause} onClick={togglePause} aria-label={paused ? "Play conversation demo" : "Pause conversation demo"} aria-pressed={paused} hidden={reduceMotion}>
          {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}<span>{paused ? "Play demo" : "Pause demo"}</span>
        </button>
        {reduceMotion && <span className={styles.staticLabel}>Example conversation</span>}
      </div>
    </div>
  );
}
