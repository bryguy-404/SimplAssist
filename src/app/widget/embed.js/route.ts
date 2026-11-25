import { NextResponse } from "next/server";
import { getCanonicalAppOrigin } from "@/lib/branding/defaultBrand";

export async function GET() {
  const canonicalPublicApiOrigin = getCanonicalAppOrigin();
  const js = `(function() {
  if (window.__saWidgetLoaded) return;
  window.__saWidgetLoaded = true;

  var script = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/widget/embed.js') !== -1) return scripts[i];
    }
    return null;
  })();

  var businessId = script ? script.getAttribute('data-business-id') : null;
  if (!businessId) { console.error('SimplAssist: missing data-business-id'); return; }

  var baseUrl = script.src.substring(0, script.src.indexOf('/widget/embed.js'));
  var isPreview = !!(script && script.getAttribute('data-preview') === 'true');
  var apiBaseUrl = isPreview ? baseUrl : ${JSON.stringify(canonicalPublicApiOrigin)};
  var configPath = isPreview
    ? '/api/widget/preview-config'
    : '/api/widget/config';
  var homepageOnly = script && script.getAttribute('data-homepage-only') === 'true';

  var config = null;
  var messages = [];
  var storageKey = 'sa-session-' + businessId;
  var timestampKey = 'sa-session-ts-' + businessId;
  var SESSION_TIMEOUT = 5 * 60 * 60 * 1000;
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function createId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = [];
      for (var h = 0; h < bytes.length; h++) hex.push(bytes[h].toString(16).padStart(2, '0'));
      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
    }
    return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
  }

  var sessionId = null;
  var sessionExpired = false;
  try {
    sessionId = localStorage.getItem(storageKey);
    if (sessionId && !UUID_PATTERN.test(sessionId)) sessionId = null;
    var lastTs = localStorage.getItem(timestampKey);
    if (sessionId && lastTs && (Date.now() - Number(lastTs)) > SESSION_TIMEOUT) {
      sessionId = null;
      sessionExpired = true;
    }
  } catch(e) {}
  if (!sessionId) {
    sessionId = createId();
    try {
      localStorage.setItem(storageKey, sessionId);
      localStorage.setItem(timestampKey, String(Date.now()));
    } catch(e) {}
  }
  var isOpen = false;
  var isLoading = false;
  var unreadCount = 0;
  var attentionDismissed = false;
  var messageCount = 0;
  var leadCaptured = false;
  var visitorName = '';
  var visitorEmail = '';
  var widgetToken = null;
  var widgetSessionNonce = null;
  var pendingClientMessageId = null;
  var pendingClientMessageText = null;
  var pendingLeadClientId = null;
  var pendingLeadMessage = null;
  var pendingLeadSourceClientMessageId = null;
  var pendingPreviewPatch = null;
  var configInitialized = false;
  var configRequestInFlight = false;
  var configRetryTimer = null;
  var CONFIG_RETRY_DELAYS = [750, 1500, 3000];
  var configRetryAttempt = 0;
  var CONFIG_REFRESH_INTERVAL = 60 * 1000;
  var PROACTIVE_STORAGE_VERSION = 'v1';
  var proactiveShownKey = 'sa-proactive-' + PROACTIVE_STORAGE_VERSION + '-shown-' + businessId;
  var proactiveDismissedKey = 'sa-proactive-' + PROACTIVE_STORAGE_VERSION + '-dismissed-' + businessId;
  var PROACTIVE_SHOWN_TTL = 24 * 60 * 60 * 1000;
  var PROACTIVE_DISMISSED_TTL = 7 * 24 * 60 * 60 * 1000;
  var proactiveFinishedThisVisit = false;
  var proactiveAutoOpened = false;
  var proactiveIsMobile = false;
  var proactiveScrollReached = false;
  var proactiveMinRemaining = 0;
  var proactiveDelayRemaining = 0;
  var proactiveActiveSince = null;
  var proactiveMinTimer = null;
  var proactiveDelayTimer = null;
  var proactiveBlockedRetryTimer = null;
  var proactiveListenersAttached = false;
  var proactiveRouteObserver = null;
  var proactiveSchedulingStarted = false;
  var visitorIntentionalInteraction = false;
  var proactivePendingTriggerSource = null;
  var proactiveOpenedSource = null;
  var widgetEngagementSource = null;
  var widgetLoadedTelemetrySent = false;
  var widgetEngagementTelemetrySent = false;
  var firstMessageTelemetrySent = false;
  var prefersReducedMotion = !!(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function(k) {
      if (k === 'style' && typeof attrs[k] === 'object') {
        Object.keys(attrs[k]).forEach(function(s) { e.style[s] = attrs[k][s]; });
      } else if (k.indexOf('on') === 0) {
        e.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
      } else {
        e.setAttribute(k, attrs[k]);
      }
    });
    if (children) {
      if (typeof children === 'string') e.textContent = children;
      else if (Array.isArray(children)) children.forEach(function(c) { if (c) e.appendChild(c); });
      else e.appendChild(children);
    }
    return e;
  }

  var style = document.createElement('style');
  style.textContent = [
    '.sa-widget-container{position:fixed;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;}',
    '.sa-widget-btn{color:var(--sa-on-brand,#fff);width:60px;height:60px;padding:0;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:transform 0.2s,box-shadow 0.2s;position:relative;}',
    '.sa-widget-btn:hover{transform:scale(1.05);box-shadow:0 6px 16px rgba(0,0,0,0.2);}',
    '.sa-widget-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:50%;width:22px;height:22px;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;}',
    '.sa-widget-attention-dot{position:absolute;top:4px;right:4px;width:12px;height:12px;border-radius:50%;background:#ef4444;display:none;}',
    '.sa-widget-panel{--sa-brand:#0066FF;width:400px;height:auto;min-height:260px;max-height:500px;border-radius:18px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.14);display:flex;flex-direction:column;background:#fff;position:absolute;bottom:72px;transition:opacity 0.25s,transform 0.25s;transform-origin:bottom;}',
    '.sa-widget-panel.sa-hidden{opacity:0;visibility:hidden;transform:translateY(12px) scale(0.95);pointer-events:none;}',
    '.sa-widget-panel.sa-visible{opacity:1;visibility:visible;transform:translateY(0) scale(1);}',
    '.sa-widget-header{padding:14px 16px;color:var(--sa-on-brand,#fff);display:flex;align-items:center;gap:12px;flex-shrink:0;}',
    '.sa-widget-header-avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;overflow:hidden;background:rgba(255,255,255,0.22);position:relative;}',
    '.sa-widget-header-avatar img{width:100%;height:100%;object-fit:cover;display:block;}',
    // The mascot: a dot with eyes that stands in for a logo. It idles, watches
    // the pointer, looks down while the visitor types, tilts while a reply is
    // on its way and smiles when one arrives. Colours come from applyMascotColors.
    '.sa-widget-header-avatar.sa-has-pet{overflow:visible;background:transparent;}',
    '.sa-widget-pet{--sa-pet:#fff;--sa-pet-ink:#1c1917;position:absolute;top:2px;right:2px;bottom:2px;left:2px;display:none;box-sizing:border-box;transform-origin:50% 100%;transition:transform 0.26s cubic-bezier(0.3,1.6,0.5,1);}',
    '.sa-widget-header-avatar.sa-has-pet .sa-widget-pet{display:block;}',
    '.sa-widget-pet-dot{position:absolute;top:0;right:0;bottom:0;left:0;box-sizing:border-box;border-radius:50%;background:var(--sa-pet);box-shadow:0 0 0 2px var(--sa-pet-ring,rgba(255,255,255,0.85)),inset 0 -5px 0 rgba(0,0,0,0.12),inset 0 3px 0 rgba(255,255,255,0.25);animation:sa-widget-pet-bob 3.6s ease-in-out infinite;}',
    '.sa-widget-pet-eyes{position:absolute;left:0;right:0;top:32%;height:8px;display:flex;align-items:center;justify-content:center;gap:7px;transition:transform 0.12s ease-out;}',
    '.sa-widget-pet-eye{display:block;box-sizing:border-box;width:5px;height:7px;border:0 solid var(--sa-pet-ink);border-radius:50%;background-color:var(--sa-pet-ink);animation:sa-widget-pet-blink 4.6s infinite;}',
    '.sa-widget-pet[data-mood="listening"] .sa-widget-pet-eyes{transform:translate(1.5px,2.5px);}',
    '.sa-widget-pet[data-mood="thinking"]{transform:rotate(-9deg);}',
    '.sa-widget-pet[data-mood="thinking"] .sa-widget-pet-eyes{transform:translate(2px,-2.5px);}',
    '.sa-widget-pet[data-mood="thinking"] .sa-widget-pet-dot{animation:sa-widget-pet-think 1.4s ease-in-out infinite;}',
    '.sa-widget-pet.sa-pet-cheer{animation:sa-widget-pet-hop 0.56s;}',
    '.sa-widget-pet.sa-pet-cheer .sa-widget-pet-eyes{animation:sa-widget-pet-squeeze 1.8s;}',
    '.sa-widget-pet.sa-pet-cheer .sa-widget-pet-eye{animation:sa-widget-pet-smile 1.8s,sa-widget-pet-blink 4.6s 1.8s infinite;}',
    '@keyframes sa-widget-pet-bob{0%,100%{transform:none;}50%{transform:translateY(-2px);}}',
    '@keyframes sa-widget-pet-blink{0%,94%,100%{transform:none;}97%{transform:scaleY(0.12);}}',
    '@keyframes sa-widget-pet-think{0%,100%{transform:rotate(-3deg);}50%{transform:rotate(4deg);}}',
    '@keyframes sa-widget-pet-hop{0%,100%{transform:none;}25%{transform:translateY(2px) scale(1.12,0.86);}55%{transform:translateY(-7px) scale(0.95,1.08);}80%{transform:translateY(0) scale(1.08,0.92);}}',
    '@keyframes sa-widget-pet-squeeze{0%,100%{gap:7px;}8%,88%{gap:4px;}}',
    '@keyframes sa-widget-pet-smile{0%,100%{width:5px;height:7px;border-width:0;border-radius:50%;background-color:var(--sa-pet-ink);}8%,88%{width:9px;height:5px;border-width:2.5px 2.5px 0;border-radius:9px 9px 0 0;background-color:transparent;}}',
    '@media(prefers-reduced-motion:reduce){.sa-widget-pet,.sa-widget-pet *{animation:none!important;transition:none!important;}}',
    '.sa-widget-header-center{flex:1;min-width:0;text-align:left;}',
    '.sa-widget-header-center h3{margin:0;font-size:16px;font-weight:600;line-height:1.25;}',
    '.sa-widget-header-subtitle{margin:4px 0 0;font-size:12px;font-weight:400;opacity:0.92;line-height:1.3;}',
    '.sa-widget-header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '.sa-widget-status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px rgba(255,255,255,0.35);flex-shrink:0;}',
    '.sa-widget-close{width:44px;height:44px;background:none;border:none;color:var(--sa-on-brand,#fff);cursor:pointer;padding:0;opacity:0.9;font-size:22px;line-height:1;display:flex;align-items:center;justify-content:center;}',
    '.sa-widget-close:hover{opacity:1;}',
    '.sa-widget-messages{flex:1 1 auto;align-self:stretch;overflow-y:auto;min-height:0;max-height:calc(500px - 200px);padding:16px;display:flex;flex-direction:column;gap:10px;background:#fff;}',
    '.sa-widget-msg{max-width:85%;padding:12px 14px;border-radius:14px;word-wrap:break-word;font-size:14px;line-height:1.45;}',
    '.sa-widget-msg-bot{align-self:flex-start;background:#eef1f4;color:#1a1a1a;border-bottom-left-radius:6px;}',
    '.sa-widget-msg-user{align-self:flex-end;color:var(--sa-on-brand,#fff);box-shadow:inset 0 0 0 1px var(--sa-brand-edge,transparent);border-bottom-right-radius:6px;}',
    '.sa-widget-input-area{padding:12px 16px;border-top:1px solid #e8eaed;display:flex;gap:10px;align-items:center;flex-shrink:0;background:#fff;}',
    '.sa-widget-input{flex:1;border:1px solid #d1d5db;border-radius:999px;padding:10px 16px;font-size:16px;outline:none;font-family:inherit;background:#fff;color:#1a1a1a;}',
    '.sa-widget-input::placeholder{color:#9ca3af;}',
    '.sa-widget-input:focus{border-color:var(--sa-brand-ink,var(--sa-brand));box-shadow:0 0 0 2px rgba(0,0,0,0.06);}',
    '.sa-widget-send{color:var(--sa-on-brand,#fff);box-shadow:inset 0 0 0 1px var(--sa-brand-edge,transparent);width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity 0.2s;flex-shrink:0;}',
    '.sa-widget-send:disabled{opacity:0.5;cursor:default;}',
    '.sa-widget-footer{padding:10px 12px;border-top:1px solid #e8eaed;background:#f3f4f6;flex-shrink:0;text-align:center;font-size:11px;line-height:1.4;}',
    '.sa-widget-footer a{color:#9ca3af;text-decoration:none;}',
    '.sa-widget-footer a:hover{color:#6b7280;text-decoration:underline;}',
    '.sa-widget-loading-dot{width:12px;height:12px;border-radius:50%;background:var(--sa-brand-ink,var(--sa-brand,#ff8c42));flex-shrink:0;margin:10px 14px;align-self:flex-start;animation:sa-widget-dot-pulse 1.5s infinite;}',
    '@keyframes sa-widget-dot-pulse{0%{transform:scale(1);opacity:1;}50%{transform:scale(1.6);opacity:0.4;}100%{transform:scale(1);opacity:1;}}',
    '.sa-widget-cursor{display:inline-block;width:2px;height:1em;background:#1a1a1a;margin-left:1px;vertical-align:text-bottom;animation:sa-widget-blink 0.7s step-end infinite;}',
    '@keyframes sa-widget-blink{0%,100%{opacity:1;}50%{opacity:0;}}',
    '.sa-widget-lead-form{padding:20px 16px;display:flex;flex-direction:column;gap:12px;}',
    '.sa-widget-lead-form p{margin:0;font-size:14px;color:#4a5568;text-align:center;}',
    '.sa-widget-lead-input{border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;font-size:16px;outline:none;font-family:inherit;}',
    '.sa-widget-lead-input:focus{border-color:var(--sa-brand-ink,var(--sa-brand));box-shadow:0 0 0 2px rgba(0,0,0,0.06);}',
    '.sa-widget-lead-btn{border:none;color:var(--sa-on-brand,#fff);box-shadow:inset 0 0 0 1px var(--sa-brand-edge,transparent);border-radius:8px;padding:10px;font-size:14px;font-weight:600;cursor:pointer;}',
    '.sa-widget-lead-btn:disabled{opacity:0.6;cursor:default;}',
    '.sa-widget-lead-skip{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:12px;text-align:center;}',
    '.sa-widget-lead-status{min-height:18px;margin:0!important;font-size:12px!important;color:#6b7280!important;text-align:left!important;}',
    '.sa-widget-lead-status.sa-widget-lead-error{color:#b91c1c!important;}',
    '@media(max-width:600px), (max-height:500px) and (max-width:950px) and (pointer:coarse){.sa-widget-panel{width:auto;min-width:0;min-height:0;height:var(--sa-mobile-expanded-height,78dvh);max-height:var(--sa-mobile-expanded-height,78dvh);position:fixed;top:auto;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));bottom:calc(max(12px,env(safe-area-inset-bottom)) + var(--sa-vv-bottom-offset,0px));border-radius:18px;transform-origin:bottom center;}.sa-widget-panel.sa-mobile-compact{height:var(--sa-mobile-compact-height,48dvh);max-height:var(--sa-mobile-compact-height,48dvh);}.sa-widget-panel.sa-mobile-expanded{height:var(--sa-mobile-expanded-height,78dvh);max-height:var(--sa-mobile-expanded-height,78dvh);}.sa-widget-panel.sa-viewport-constrained{inset:var(--sa-vv-offset-top,0px) 0 auto 0;width:100vw;height:var(--sa-visual-height,100dvh);max-height:var(--sa-visual-height,100dvh);border-radius:0;}.sa-widget-messages{max-height:none;flex:1;min-height:0;padding-bottom:max(16px,env(safe-area-inset-bottom));}.sa-widget-container.sa-open .sa-widget-btn{display:none;}}',
    '@media(min-width:601px) and (max-width:950px) and (max-height:500px) and (pointer:coarse){.sa-widget-panel:not(.sa-viewport-constrained){width:min(560px,calc(100vw - 24px));}}',
    '@media(prefers-reduced-motion:reduce){.sa-widget-panel,.sa-widget-btn,.sa-widget-send,.sa-widget-end,.sa-widget-quick-reply-btn{transition:none!important;animation:none!important;}.sa-widget-loading-dot,.sa-widget-cursor{animation:none!important;}}',
    '.sa-widget-btn.sa-btn-hidden{opacity:0;transform:scale(0.8);pointer-events:none;}',
    '.sa-widget-btn.sa-btn-visible{opacity:1;transform:scale(1);transition:opacity 0.4s ease,transform 0.4s ease;}',
    '.sa-widget-end-area{padding:0 16px 8px;text-align:center;background:#fff;flex-shrink:0;}',
    '.sa-widget-end{background:none;border:none;color:#9ca3af;cursor:pointer;padding:0;font-size:11px;font-weight:500;transition:color 0.2s;}',
    '.sa-widget-end:hover{color:#ef4444;}',
    '.sa-widget-quick-replies{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px;align-self:stretch;}',
    '.sa-widget-quick-reply-btn{border:1.5px solid var(--sa-brand-ink,var(--sa-brand,#0066FF));color:var(--sa-brand-ink,var(--sa-brand,#0066FF));background:transparent;border-radius:999px;padding:8px 16px;font-size:13px;font-family:inherit;cursor:pointer;transition:background 0.2s,color 0.2s;line-height:1.3;white-space:normal;text-align:left;}',
    '.sa-widget-quick-reply-btn:hover{background:var(--sa-brand-ink,var(--sa-brand,#0066FF));color:#fff;}'
  ].join('\\n');
  document.head.appendChild(style);

  var container = el('div', { class: 'sa-widget-container' });
  if (homepageOnly) container.setAttribute('data-homepage-only', 'true');
  var btn = el('button', { class: 'sa-widget-btn', type: 'button', 'aria-label': 'Open chat', 'aria-expanded': 'false', 'aria-controls': 'sa-widget-panel', 'aria-hidden': 'true', tabindex: '-1', disabled: '' });
  btn.disabled = true;
  btn.tabIndex = -1;
  var badge = el('div', { class: 'sa-widget-badge', style: { display: 'none' } }, '0');
  var attentionDot = el('div', { class: 'sa-widget-attention-dot', style: { display: 'none' }, 'aria-hidden': 'true' });
  var panel = el('div', { class: 'sa-widget-panel sa-hidden', id: 'sa-widget-panel', role: 'dialog', 'aria-modal': 'false', 'aria-hidden': 'true', 'aria-labelledby': 'sa-widget-title', inert: '' });
  try { panel.inert = true; } catch(e) {}
  var header = el('div', { class: 'sa-widget-header' });
  var avatarWrap = el('div', { class: 'sa-widget-header-avatar' });
  var avatarImg = el('img', { class: 'sa-widget-header-avatar-img', alt: '' });
  avatarImg.style.display = 'none';
  var pet = el('span', { class: 'sa-widget-pet', 'aria-hidden': 'true', 'data-mood': 'idle' });
  var petDot = el('span', { class: 'sa-widget-pet-dot' });
  var petEyes = el('span', { class: 'sa-widget-pet-eyes' });
  petEyes.appendChild(el('span', { class: 'sa-widget-pet-eye' }));
  petEyes.appendChild(el('span', { class: 'sa-widget-pet-eye' }));
  petDot.appendChild(petEyes);
  pet.appendChild(petDot);
  avatarWrap.appendChild(avatarImg);
  avatarWrap.appendChild(pet);
  var titleH3 = el('h3', { id: 'sa-widget-title' }, 'Loading...');
  var subtitleP = el('p', { class: 'sa-widget-header-subtitle' }, 'Typically replies instantly');
  var headerCenter = el('div', { class: 'sa-widget-header-center' });
  headerCenter.appendChild(titleH3);
  headerCenter.appendChild(subtitleP);
  var statusDot = el('span', { class: 'sa-widget-status-dot' });
  statusDot.setAttribute('aria-hidden', 'true');
  var closeBtn = el('button', { class: 'sa-widget-close', onClick: togglePanel, type: 'button', 'aria-label': 'Close chat' }, '\\u00D7');
  var headerActions = el('div', { class: 'sa-widget-header-actions' });
  headerActions.appendChild(statusDot);
  headerActions.appendChild(closeBtn);
  header.appendChild(avatarWrap);
  header.appendChild(headerCenter);
  header.appendChild(headerActions);
  var messagesArea = el('div', { class: 'sa-widget-messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
  var inputArea = el('div', { class: 'sa-widget-input-area' });
  var input = el('input', { class: 'sa-widget-input', placeholder: 'Type your message...', type: 'text', maxlength: '2000', 'aria-label': 'Chat message' });
  var sendBtn = el('button', { class: 'sa-widget-send', type: 'button', 'aria-label': 'Send message' });
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  var footerEl = el('div', { class: 'sa-widget-footer' });
  var footerLink = el('a', { href: baseUrl + '/', target: '_blank', rel: 'noopener noreferrer' }, 'Powered by SimplAssist');
  footerEl.appendChild(footerLink);
  var endArea = el('div', { class: 'sa-widget-end-area' });
  endArea.style.display = 'none';
  var endBtn = el('button', { class: 'sa-widget-end', onClick: endConversation, type: 'button' }, 'End Conversation');
  endArea.appendChild(endBtn);

  input.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  input.addEventListener('input', function() {
    if (input.value) markIntentionalInteraction();
    nodPet();
  });
  input.addEventListener('focus', function() {
    if (isOpen) markIntentionalInteraction(true);
    petListening = true;
    updatePetMood();
  });
  input.addEventListener('blur', function() {
    petListening = false;
    updatePetMood();
  });
  panel.addEventListener('pointerdown', handlePanelPointerEngagement);
  sendBtn.addEventListener('click', sendMessage);
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  panel.appendChild(header);
  panel.appendChild(messagesArea);
  panel.appendChild(inputArea);
  panel.appendChild(endArea);
  panel.appendChild(footerEl);
  btn.appendChild(badge);
  btn.appendChild(attentionDot);
  container.appendChild(panel);
  container.appendChild(btn);
  document.body.appendChild(container);
  btn.addEventListener('click', togglePanel);
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || !isOpen) return;
    if (!widgetShouldHandleEscape(e)) return;
    if (e.preventDefault) e.preventDefault();
    closePanel(true);
  });

  function positionWidget(pos) {
    container.style.bottom = '20px';
    if (pos === 'bottom_left') {
      container.style.left = '20px';
      container.style.right = 'auto';
    } else {
      container.style.right = '20px';
      container.style.left = 'auto';
    }
    if (isMobileViewport()) {
      if (panel.classList.contains('sa-viewport-constrained')) {
        panel.style.width = '100vw';
        panel.style.left = '0';
        panel.style.right = '0';
      } else if (isShortCoarseMobileViewport()) {
        panel.style.width = 'min(560px, calc(100vw - 24px))';
        if (pos === 'bottom_left') {
          panel.style.left = 'max(12px, env(safe-area-inset-left))';
          panel.style.right = 'auto';
        } else {
          panel.style.right = 'max(12px, env(safe-area-inset-right))';
          panel.style.left = 'auto';
        }
      } else {
        panel.style.width = 'auto';
        panel.style.left = 'max(12px, env(safe-area-inset-left))';
        panel.style.right = 'max(12px, env(safe-area-inset-right))';
      }
    } else if (pos === 'bottom_left') {
      panel.style.width = '';
      panel.style.left = '0';
      panel.style.right = 'auto';
    } else {
      panel.style.width = '';
      panel.style.right = '0';
      panel.style.left = 'auto';
    }
  }

  function applyBrandColor(color) {
    btn.className = 'sa-widget-btn';
    btn.style.backgroundColor = color;
    btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.appendChild(badge);
    btn.appendChild(attentionDot);
    panel.style.setProperty('--sa-brand', color);
    header.style.backgroundColor = color;
    sendBtn.style.backgroundColor = color;
    // White text and icons disappear on a white or very light brand colour, so
    // they turn dark there, brand-coloured text on white turns grey, and
    // brand-coloured shapes get a faint edge. The cut-off leaves every colour
    // that already reads well exactly as it was.
    var lightBrand = HEX_COLOR.test(color || '') && colorLuminance(color) > 0.5;
    container.style.setProperty('--sa-on-brand', lightBrand ? '#1c1917' : '#fff');
    container.style.setProperty('--sa-brand-ink', lightBrand ? '#374151' : color);
    container.style.setProperty('--sa-brand-edge', lightBrand ? '#d1d5db' : 'transparent');
    header.style.borderBottom = lightBrand ? '1px solid #e8eaed' : '';
    btn.style.border = lightBrand ? '1px solid #e5e7eb' : '';
  }

  function updateLauncherIndicators() {
    if (isOpen) {
      badge.style.display = 'none';
      attentionDot.style.display = 'none';
      return;
    }
    if (unreadCount > 0) {
      badge.textContent = String(unreadCount);
      badge.style.display = 'flex';
      attentionDot.style.display = 'none';
      return;
    }
    if (!attentionDismissed) {
      badge.style.display = 'none';
      attentionDot.style.display = 'block';
      return;
    }
    badge.style.display = 'none';
    attentionDot.style.display = 'none';
  }

  // A logo wins when one is uploaded and switched on; otherwise the mascot shows.
  function applyHeaderAvatar(showLogo, logoUrl) {
    if (showLogo && logoUrl) {
      avatarWrap.classList.add('sa-has-logo');
      avatarWrap.classList.remove('sa-has-pet');
      avatarImg.style.display = 'block';
      avatarImg.src = logoUrl;
    } else {
      showMascotAvatar();
    }
  }

  function showMascotAvatar() {
    avatarWrap.classList.remove('sa-has-logo');
    avatarWrap.classList.add('sa-has-pet');
    avatarImg.removeAttribute('src');
    avatarImg.style.display = 'none';
  }

  avatarImg.addEventListener('error', showMascotAvatar);

  var HEX_COLOR = /^#[0-9a-f]{6}$/i;
  var DEFAULT_MASCOT_COLOR = '#FFFFFF';
  var MASCOT_DARK_INK = '#1c1917';

  function colorLuminance(hex) {
    var value = parseInt(hex.slice(1), 16);
    var channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    for (var c = 0; c < 3; c++) {
      var share = channels[c] / 255;
      channels[c] = share <= 0.03928 ? share / 12.92 : Math.pow((share + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function colorContrast(a, b) {
    var la = colorLuminance(a);
    var lb = colorLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // On a light dot the eyes take the brand colour when it stands out, so a
  // white dot looks cut from the header. Otherwise they go dark or white,
  // whichever reads better against the dot.
  function applyMascotColors(mascotColor, brandColor) {
    var dot = HEX_COLOR.test(mascotColor || '') ? mascotColor : DEFAULT_MASCOT_COLOR;
    var ink = MASCOT_DARK_INK;
    if (
      colorLuminance(dot) > 0.6 &&
      HEX_COLOR.test(brandColor || '') &&
      colorContrast(brandColor, dot) >= 3
    ) ink = brandColor;
    else if (colorContrast('#ffffff', dot) > colorContrast(ink, dot)) ink = '#ffffff';
    // The ring keeps the dot's edge visible: white on most headers, a soft
    // dark line on a white or very light one.
    var lightHeader = HEX_COLOR.test(brandColor || '') && colorLuminance(brandColor) > 0.7;
    pet.style.setProperty('--sa-pet', dot);
    pet.style.setProperty('--sa-pet-ink', ink);
    pet.style.setProperty('--sa-pet-ring', lightHeader ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.85)');
  }

  var petListening = false;
  var petThinking = false;
  var petLookFrame = 0;

  // Waiting on a reply outranks listening to the visitor type.
  function updatePetMood() {
    var mood = petThinking ? 'thinking' : petListening ? 'listening' : 'idle';
    if (pet.getAttribute('data-mood') === mood) return;
    pet.setAttribute('data-mood', mood);
    if (mood !== 'idle') petEyes.style.transform = '';
  }

  // A small hop and a smile: when the chat opens and when a reply arrives.
  function cheerPet() {
    pet.classList.remove('sa-pet-cheer');
    void pet.offsetWidth; // restarts the animation if one is already playing
    pet.classList.add('sa-pet-cheer');
  }

  // A small nod for each keystroke.
  function nodPet() {
    if (prefersReducedMotion || typeof petDot.animate !== 'function') return;
    try {
      petDot.animate([
        { transform: 'none' },
        { transform: 'translateY(2px) scale(1.05,0.94)' },
        { transform: 'none' }
      ], { duration: 190, easing: 'ease-out' });
    } catch(e) {}
  }

  // The eyes follow the pointer a little while the chat is open and idle.
  function petLook(event) {
    if (prefersReducedMotion || !isOpen || petThinking || petListening || petLookFrame) return;
    if (!avatarWrap.classList.contains('sa-has-pet')) return;
    if (!window.requestAnimationFrame || typeof petDot.getBoundingClientRect !== 'function') return;
    var x = event.clientX;
    var y = event.clientY;
    petLookFrame = window.requestAnimationFrame(function() {
      petLookFrame = 0;
      var box = petDot.getBoundingClientRect();
      var dx = x - (box.left + box.width / 2);
      var dy = y - (box.top + box.height / 2);
      var distance = Math.sqrt(dx * dx + dy * dy) || 1;
      var reach = Math.min(1, distance / 160) * 2.4;
      petEyes.style.transform = 'translate(' + (dx / distance * reach).toFixed(2) + 'px,' + (dy / distance * reach).toFixed(2) + 'px)';
    });
  }

  document.addEventListener('pointermove', petLook, { passive: true });

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch(e) { return null; }
  }

  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch(e) {}
  }

  function storedTimestampIsRecent(key, ttl) {
    var raw = safeStorageGet(key);
    if (!raw) return false;
    var storedAt = Number(raw);
    var age = Date.now() - storedAt;
    return Number.isFinite(storedAt) && storedAt > 0 && age >= 0 && age < ttl;
  }

  function proactiveInvitationIsStorageSuppressed() {
    return !!(
      !isPreview &&
      (storedTimestampIsRecent(proactiveDismissedKey, PROACTIVE_DISMISSED_TTL) ||
        storedTimestampIsRecent(proactiveShownKey, PROACTIVE_SHOWN_TTL))
    );
  }

  function proactiveInvitationEnabled(data) {
    return !!(
      data &&
      (data.proactiveInvitationEnabled === true || data.proactive_invitation_enabled === true)
    );
  }

  function isMobileViewport() {
    var viewport = window.visualViewport;
    var width = typeof window.innerWidth === 'number'
      ? window.innerWidth
      : (viewport && viewport.width);
    return (
      (typeof width === 'number' && width <= 600) ||
      isShortCoarseMobileViewport()
    );
  }

  function isShortCoarseMobileViewport() {
    var viewport = window.visualViewport;
    var width = typeof window.innerWidth === 'number'
      ? window.innerWidth
      : (viewport && viewport.width);
    var height = typeof window.innerHeight === 'number'
      ? window.innerHeight
      : (viewport && viewport.height);
    var coarsePointer = false;
    if (window.matchMedia) {
      try { coarsePointer = window.matchMedia('(pointer: coarse)').matches; } catch(e) {}
    }
    return !!(
      coarsePointer &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      width <= 950 &&
      height <= 500
    );
  }

  function viewportHeight() {
    var viewport = window.visualViewport;
    if (viewport && typeof viewport.height === 'number') return viewport.height;
    return typeof window.innerHeight === 'number' ? window.innerHeight : 800;
  }

  function updateViewportMetrics() {
    var viewport = window.visualViewport;
    var height = viewportHeight();
    var width = viewport && typeof viewport.width === 'number'
      ? viewport.width
      : window.innerWidth;
    var offsetTop = viewport && typeof viewport.offsetTop === 'number' ? viewport.offsetTop : 0;
    var layoutHeight = typeof window.innerHeight === 'number' ? window.innerHeight : height;
    var bottomOffset = Math.max(0, layoutHeight - (offsetTop + height));
    panel.style.setProperty('--sa-visual-height', Math.max(1, Math.round(height)) + 'px');
    panel.style.setProperty('--sa-vv-offset-top', Math.max(0, Math.round(offsetTop)) + 'px');
    panel.style.setProperty('--sa-vv-bottom-offset', Math.max(0, Math.round(bottomOffset)) + 'px');
    var shortMobile = isMobileViewport() && height <= 500;
    var compactMinimum = 260;
    var expandedMinimum = shortMobile ? 280 : 300;
    var compactHeight = Math.min(
      Math.max(1, height - 24),
      Math.max(compactMinimum, Math.round(height * 0.48))
    );
    var expandedHeight = Math.min(
      Math.max(1, height - 24),
      Math.max(expandedMinimum, Math.round(height * 0.78))
    );
    panel.style.setProperty('--sa-mobile-compact-height', compactHeight + 'px');
    panel.style.setProperty('--sa-mobile-expanded-height', expandedHeight + 'px');
    var constrained = isMobileViewport() && (
      height < 360 ||
      (typeof width === 'number' && width <= 340 && height <= 480)
    );
    if (constrained) panel.classList.add('sa-viewport-constrained');
    else panel.classList.remove('sa-viewport-constrained');
    if (config) positionWidget(config.position || 'bottom_right');
  }

  function setMobilePanelPresentation(intentional) {
    proactiveIsMobile = isMobileViewport();
    panel.classList.remove('sa-mobile-compact');
    panel.classList.remove('sa-mobile-expanded');
    if (proactiveIsMobile) {
      panel.classList.add(intentional ? 'sa-mobile-expanded' : 'sa-mobile-compact');
    }
    updateViewportMetrics();
  }

  function markProactiveShown() {
    if (!isPreview) safeStorageSet(proactiveShownKey, String(Date.now()));
  }

  function markProactiveDismissed() {
    if (!isPreview) safeStorageSet(proactiveDismissedKey, String(Date.now()));
  }

  function emitWidgetTelemetry(eventType, source) {
    if (
      isPreview ||
      !widgetToken ||
      !widgetSessionNonce ||
      !source
    ) return;
    var telemetryPayload = {
      businessId: businessId,
      sessionId: sessionId,
      sessionNonce: widgetSessionNonce,
      eventType: eventType,
      source: source,
      deviceBucket: isMobileViewport() ? 'mobile' : 'desktop',
      promptVersion: 1
    };
    try {
      fetch(apiBaseUrl + '/api/widget/telemetry?businessId=' + encodeURIComponent(businessId) + '&sessionId=' + encodeURIComponent(sessionId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + widgetToken
        },
        body: JSON.stringify(telemetryPayload),
        keepalive: true
      }).catch(function() {});
    } catch(e) {}
  }

  function recordWidgetEngagement(source) {
    if (!widgetEngagementSource) widgetEngagementSource = source;
    if (widgetEngagementTelemetrySent) return;
    widgetEngagementTelemetrySent = true;
    emitWidgetTelemetry('widget_engaged', widgetEngagementSource);
  }

  function widgetLoadedTelemetryIsPendingForHomepageRoute() {
    return !!(
      homepageOnly &&
      !isPreview &&
      !widgetLoadedTelemetrySent &&
      config &&
      widgetToken &&
      widgetSessionNonce
    );
  }

  function releaseHomepageRouteObserverIfIdle() {
    if (
      !proactiveRouteObserver ||
      proactiveSchedulingStarted ||
      widgetLoadedTelemetryIsPendingForHomepageRoute()
    ) return;
    proactiveRouteObserver.disconnect();
    proactiveRouteObserver = null;
  }

  function ensureHomepageRouteObserver() {
    if (
      !homepageOnly ||
      proactiveRouteObserver ||
      !window.MutationObserver ||
      !document.body
    ) return;
    proactiveRouteObserver = new window.MutationObserver(handleHomepageRouteChange);
    proactiveRouteObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  function clearProactiveTimers() {
    if (proactiveMinTimer) clearTimeout(proactiveMinTimer);
    if (proactiveDelayTimer) clearTimeout(proactiveDelayTimer);
    if (proactiveBlockedRetryTimer) clearTimeout(proactiveBlockedRetryTimer);
    proactiveMinTimer = null;
    proactiveDelayTimer = null;
    proactiveBlockedRetryTimer = null;
  }

  function detachProactiveListeners() {
    if (proactiveListenersAttached) {
      window.removeEventListener('scroll', handleProactiveScroll);
      window.removeEventListener('storage', handleProactiveStorageChange);
      document.removeEventListener('visibilitychange', handleProactiveVisibilityChange);
      proactiveListenersAttached = false;
    }
    releaseHomepageRouteObserverIfIdle();
  }

  function stopProactiveScheduling() {
    clearProactiveTimers();
    proactiveSchedulingStarted = false;
    detachProactiveListeners();
    proactiveActiveSince = null;
  }

  function finishProactiveInvitationForVisit() {
    proactiveFinishedThisVisit = true;
    stopProactiveScheduling();
  }

  function pageIsVisible() {
    return document.visibilityState !== 'hidden';
  }

  function homepageRouteAllowsWidget() {
    return !homepageOnly || !!(
      document.body &&
      document.body.classList &&
      document.body.classList.contains('sa-homepage-widget-route')
    );
  }

  function proactivePageIsActive() {
    return pageIsVisible() && homepageRouteAllowsWidget();
  }

  function emitWidgetLoadedTelemetryIfEligible() {
    if (
      isPreview ||
      widgetLoadedTelemetrySent ||
      !config ||
      !widgetToken ||
      !widgetSessionNonce ||
      !homepageRouteAllowsWidget()
    ) return;
    widgetLoadedTelemetrySent = true;
    emitWidgetTelemetry('widget_loaded', 'widget_load');
  }

  function visitorIsTyping() {
    var active = document.activeElement;
    if (!active || active === document.body) return false;
    var tag = active.tagName ? String(active.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'iframe') return true;
    if (active.isContentEditable === true) return true;

    var editableCandidate = null;
    if (active.closest) {
      try { editableCandidate = active.closest('[contenteditable]'); } catch(e) {}
    }
    var current = editableCandidate || active;
    while (current) {
      if (current.getAttribute) {
        var editableValue = current.getAttribute('contenteditable');
        if (editableValue !== null) {
          var normalizedEditableValue = String(editableValue).trim().toLowerCase();
          if (normalizedEditableValue === 'false') return false;
          if (
            normalizedEditableValue === '' ||
            normalizedEditableValue === 'true' ||
            normalizedEditableValue === 'plaintext-only'
          ) return true;
        }
      }
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function panelTargetIsInteractive(target) {
    if (!target) return false;
    if (target.closest) {
      try {
        if (target.closest('button,input,textarea,select,a,label,summary,[role="button"],[role="link"],[contenteditable]')) {
          return true;
        }
      } catch(e) {}
    }
    var current = target;
    while (current && current !== panel) {
      var currentTag = current.tagName ? String(current.tagName).toLowerCase() : '';
      if (
        currentTag === 'button' ||
        currentTag === 'input' ||
        currentTag === 'textarea' ||
        currentTag === 'select' ||
        currentTag === 'a' ||
        currentTag === 'label' ||
        currentTag === 'summary'
      ) return true;
      if (current.getAttribute) {
        var role = current.getAttribute('role');
        if (role === 'button' || role === 'link') return true;
        if (current.getAttribute('contenteditable') !== null) return true;
      }
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function handlePanelPointerEngagement(event) {
    if (!isOpen || !proactiveAutoOpened) return;
    if (event.isPrimary === false) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (panelTargetIsInteractive(event.target)) return;
    markPresentationEngagement();
  }

  function anotherModalIsOpen() {
    try {
      var selectors = ['dialog[open]', '[role="dialog"][aria-modal="true"]', '[aria-modal="true"]'];
      for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
        var modals = document.querySelectorAll(selectors[selectorIndex]);
        for (var modalIndex = 0; modalIndex < modals.length; modalIndex++) {
          var modal = modals[modalIndex];
          if (modal === panel) continue;
          if (modal.hidden || modal.getAttribute('hidden') !== null || modal.getAttribute('aria-hidden') === 'true') {
            continue;
          }
          if (window.getComputedStyle) {
            var modalStyle = window.getComputedStyle(modal);
            if (modalStyle.display === 'none' || modalStyle.visibility === 'hidden') continue;
          }
          return true;
        }
      }
      return false;
    } catch(e) {
      return false;
    }
  }

  function targetIsInsideWidget(target) {
    if (!target) return false;
    if (panel.contains) {
      try { return panel.contains(target); } catch(e) {}
    }
    var current = target;
    while (current) {
      if (current === panel) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function targetBelongsToActiveHostPopup(target) {
    if (!target || targetIsInsideWidget(target)) return false;
    if (target.closest) {
      try {
        if (target.closest('select,[role="listbox"],[role="menu"],[role="tree"],[role="grid"],[role="option"],[role="menuitem"],[role="treeitem"],[role="combobox"][aria-expanded="true"],[aria-haspopup][aria-expanded="true"]')) {
          return true;
        }
      } catch(e) {}
    }
    var current = target;
    while (current) {
      var tag = current.tagName ? String(current.tagName).toLowerCase() : '';
      if (tag === 'select') return true;
      if (current.getAttribute) {
        var role = current.getAttribute('role');
        if (
          role === 'listbox' ||
          role === 'menu' ||
          role === 'tree' ||
          role === 'grid' ||
          role === 'option' ||
          role === 'menuitem' ||
          role === 'treeitem'
        ) return true;
        if (
          current.getAttribute('aria-expanded') === 'true' &&
          (role === 'combobox' || current.getAttribute('aria-haspopup') !== null)
        ) return true;
      }
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function widgetShouldHandleEscape(event) {
    if (event.defaultPrevented || event.isComposing) return false;
    if (anotherModalIsOpen()) return false;
    if (targetBelongsToActiveHostPopup(event.target)) return false;
    return true;
  }

  function proactiveRevealIsBlocked() {
    return !proactivePageIsActive() || visitorIsTyping() || anotherModalIsOpen();
  }

  function scheduleBlockedProactiveRetry() {
    if (proactiveBlockedRetryTimer || proactiveFinishedThisVisit) return;
    proactiveBlockedRetryTimer = setTimeout(function() {
      proactiveBlockedRetryTimer = null;
      attemptProactiveReveal();
    }, 1000);
  }

  function openPanel(mode) {
    if (isOpen) return;
    var automatic = mode === 'automatic' || mode === 'preview-automatic';
    isOpen = true;
    proactiveAutoOpened = automatic;
    if (mode === 'automatic') {
      proactiveOpenedSource = proactivePendingTriggerSource || 'proactive_timer';
    }
    panel.classList.remove('sa-hidden');
    panel.classList.add('sa-visible');
    panel.setAttribute('aria-hidden', 'false');
    panel.removeAttribute('inert');
    try { panel.inert = false; } catch(e) {}
    container.classList.add('sa-open');
    cheerPet();
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close chat');
    attentionDismissed = true;
    unreadCount = 0;
    updateLauncherIndicators();
    setMobilePanelPresentation(!automatic);
    markProactiveShown();
    finishProactiveInvitationForVisit();
    if (mode === 'automatic') {
      emitWidgetTelemetry('invitation_shown', proactiveOpenedSource);
    }
    if (!automatic) {
      visitorIntentionalInteraction = true;
      recordWidgetEngagement('manual');
      var leadFormShown = needsLeadCapture();
      var firstLeadInput = leadFormShown ? showLeadForm() : null;
      if (isMobileViewport()) closeBtn.focus();
      else if (firstLeadInput) firstLeadInput.focus();
      else input.focus();
    }
    if (automatic) scrollToInvitationStart();
    else scrollToBottom();
  }

  function closePanel(explicitDismissal) {
    if (!isOpen) return;
    if (
      explicitDismissal &&
      proactiveAutoOpened &&
      !visitorIntentionalInteraction &&
      proactiveOpenedSource
    ) {
      emitWidgetTelemetry('invitation_dismissed', proactiveOpenedSource);
    }
    isOpen = false;
    proactiveAutoOpened = false;
    panel.classList.remove('sa-visible');
    panel.classList.add('sa-hidden');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    try { panel.inert = true; } catch(e) {}
    container.classList.remove('sa-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open chat');
    if (explicitDismissal) markProactiveDismissed();
    finishProactiveInvitationForVisit();
    updateLauncherIndicators();
    if (explicitDismissal) btn.focus();
  }

  function markIntentionalInteraction(focusLeadForm) {
    var engagementSource = proactiveAutoOpened && proactiveOpenedSource
      ? proactiveOpenedSource
      : (widgetEngagementSource || 'manual');
    visitorIntentionalInteraction = true;
    proactiveAutoOpened = false;
    recordWidgetEngagement(engagementSource);
    markProactiveShown();
    finishProactiveInvitationForVisit();
    if (isOpen && isMobileViewport()) setMobilePanelPresentation(true);
    if (needsLeadCapture()) {
      var firstLeadInput = showLeadForm();
      if (focusLeadForm && firstLeadInput) firstLeadInput.focus();
      return true;
    }
    return false;
  }

  function markPresentationEngagement() {
    var engagementSource = proactiveOpenedSource || widgetEngagementSource || 'manual';
    proactiveAutoOpened = false;
    recordWidgetEngagement(engagementSource);
    markProactiveShown();
    finishProactiveInvitationForVisit();
    if (isOpen && isMobileViewport()) setMobilePanelPresentation(true);
  }

  function attemptProactiveReveal(source) {
    if (source && !proactivePendingTriggerSource) {
      proactivePendingTriggerSource = source;
    }
    if (
      proactiveFinishedThisVisit ||
      isOpen ||
      !config ||
      !proactiveInvitationEnabled(config)
    ) return;
    if (proactiveInvitationIsStorageSuppressed()) {
      finishProactiveInvitationForVisit();
      return;
    }
    if (proactiveRevealIsBlocked()) {
      if (proactivePageIsActive()) scheduleBlockedProactiveRetry();
      return;
    }
    openPanel('automatic');
  }

  function handleProactiveScroll() {
    if (
      proactiveFinishedThisVisit ||
      proactiveScrollReached ||
      !proactivePageIsActive()
    ) return;
    var root = document.documentElement;
    var body = document.body;
    var scrollHeight = Math.max(
      root && root.scrollHeight ? root.scrollHeight : 0,
      body && body.scrollHeight ? body.scrollHeight : 0
    );
    var visibleHeight = typeof window.innerHeight === 'number' ? window.innerHeight : viewportHeight();
    var scrollable = scrollHeight - visibleHeight;
    if (scrollable <= 0) return;
    var scrollProgress = Math.max(0, window.scrollY || window.pageYOffset || 0) / scrollable;
    var threshold = proactiveIsMobile ? 0.4 : 0.3;
    if (scrollProgress < threshold) return;
    proactiveScrollReached = true;
    if (!proactivePendingTriggerSource) proactivePendingTriggerSource = 'proactive_scroll';
    if (proactiveMinRemaining <= 0) attemptProactiveReveal('proactive_scroll');
  }

  function pauseProactiveTimers() {
    if (proactiveActiveSince !== null) {
      var elapsed = Math.max(0, Date.now() - proactiveActiveSince);
      proactiveMinRemaining = Math.max(0, proactiveMinRemaining - elapsed);
      proactiveDelayRemaining = Math.max(0, proactiveDelayRemaining - elapsed);
    }
    clearProactiveTimers();
    proactiveActiveSince = null;
  }

  function resumeProactiveTimers() {
    if (
      proactiveFinishedThisVisit ||
      !proactiveSchedulingStarted ||
      !proactivePageIsActive()
    ) return;
    clearProactiveTimers();
    proactiveActiveSince = Date.now();
    if (proactiveMinRemaining > 0) {
      proactiveMinTimer = setTimeout(function() {
        proactiveMinTimer = null;
        proactiveMinRemaining = 0;
        if (proactiveScrollReached) attemptProactiveReveal('proactive_scroll');
      }, proactiveMinRemaining);
    }
    if (proactiveDelayRemaining > 0) {
      proactiveDelayTimer = setTimeout(function() {
        proactiveDelayTimer = null;
        proactiveDelayRemaining = 0;
        attemptProactiveReveal('proactive_timer');
      }, proactiveDelayRemaining);
    }
    if (proactiveDelayRemaining <= 0 || (proactiveMinRemaining <= 0 && proactiveScrollReached)) {
      attemptProactiveReveal(
        proactiveScrollReached ? 'proactive_scroll' : 'proactive_timer'
      );
    }
  }

  function handleProactiveVisibilityChange() {
    if (!proactivePageIsActive()) {
      pauseProactiveTimers();
      return;
    }
    resumeProactiveTimers();
  }

  function handleHomepageRouteChange() {
    emitWidgetLoadedTelemetryIfEligible();
    if (!proactivePageIsActive()) {
      pauseProactiveTimers();
      return;
    }
    resumeProactiveTimers();
    releaseHomepageRouteObserverIfIdle();
  }

  function handleProactiveStorageChange(event) {
    if (
      isPreview ||
      !event ||
      (event.key !== proactiveShownKey && event.key !== proactiveDismissedKey)
    ) return;
    if (proactiveInvitationIsStorageSuppressed()) {
      finishProactiveInvitationForVisit();
    }
  }

  function startProactiveInvitation() {
    if (
      proactiveFinishedThisVisit ||
      proactiveSchedulingStarted ||
      !config ||
      !proactiveInvitationEnabled(config)
    ) return;
    if (proactiveInvitationIsStorageSuppressed()) {
      proactiveFinishedThisVisit = true;
      return;
    }
    proactiveIsMobile = isMobileViewport();
    proactiveMinRemaining = proactiveIsMobile ? 8000 : 5000;
    proactiveDelayRemaining = proactiveIsMobile ? 12000 : 8000;
    proactiveScrollReached = false;
    proactivePendingTriggerSource = null;
    proactiveSchedulingStarted = true;
    if (!proactiveListenersAttached) {
      window.addEventListener('scroll', handleProactiveScroll, { passive: true });
      window.addEventListener('storage', handleProactiveStorageChange);
      document.addEventListener('visibilitychange', handleProactiveVisibilityChange);
      proactiveListenersAttached = true;
    }
    ensureHomepageRouteObserver();
    resumeProactiveTimers();
  }

  function forcePreviewProactiveInvitation(open) {
    if (!isPreview) return;
    if (!open) {
      if (proactiveAutoOpened) closePanel(false);
      proactiveFinishedThisVisit = false;
      return;
    }
    if (isOpen) {
      setMobilePanelPresentation(false);
      return;
    }
    proactiveFinishedThisVisit = false;
    openPanel('preview-automatic');
  }

  function handleViewportChange() {
    updateViewportMetrics();
    if (isOpen && isMobileViewport() && proactiveAutoOpened) {
      setMobilePanelPresentation(false);
    }
  }

  window.addEventListener('resize', handleViewportChange);
  if (window.visualViewport && window.visualViewport.addEventListener) {
    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);
  }

  function hideWidgetForUnavailable() {
    finishProactiveInvitationForVisit();
    config = null;
    widgetToken = null;
    widgetSessionNonce = null;
    isOpen = false;
    proactiveAutoOpened = false;
    isLoading = false;
    sendBtn.disabled = false;
    input.disabled = false;
    hideLoading();
    panel.classList.remove('sa-visible');
    panel.classList.add('sa-hidden');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    try { panel.inert = true; } catch(e) {}
    container.classList.remove('sa-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open chat');
    btn.setAttribute('aria-hidden', 'true');
    btn.setAttribute('tabindex', '-1');
    btn.setAttribute('disabled', '');
    btn.disabled = true;
    btn.tabIndex = -1;
    btn.classList.remove('sa-btn-visible');
    btn.classList.add('sa-btn-hidden');
    releaseHomepageRouteObserverIfIdle();
  }

  function endConversation() {
    if (!isPreview && (!widgetToken || !widgetSessionNonce)) {
      showTransientNotice('We could not end this conversation yet. Please try again.');
      loadWidgetConfig();
      return;
    }
    endBtn.disabled = true;
    var endHeaders = { 'Content-Type': 'application/json' };
    if (!isPreview) endHeaders.Authorization = 'Bearer ' + widgetToken;
    var endPayload = {
      businessId: businessId,
      sessionId: sessionId
    };
    if (isPreview) endPayload.preview = true;
    else endPayload.sessionNonce = widgetSessionNonce;
    fetch(apiBaseUrl + '/api/widget/end?businessId=' + encodeURIComponent(businessId) + '&sessionId=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: endHeaders,
      body: JSON.stringify(endPayload)
    })
    .then(function(r) {
      return r.json()
        .catch(function() { return {}; })
        .then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
    })
    .then(function(result) {
      endBtn.disabled = false;
      if (result.data.available === false) {
        hideWidgetForUnavailable();
        return;
      }
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) loadWidgetConfig();
        showTransientNotice('We could not end this conversation yet. Please try again.');
        return;
      }
      resetAfterConversationEnd();
    })
    .catch(function() {
      endBtn.disabled = false;
      showTransientNotice('We could not end this conversation yet. Please try again.');
    });
  }

  function resetAfterConversationEnd() {
    // Clear chat UI
    messagesArea.innerHTML = '';
    messages = [];
    messageCount = 0;
    isLoading = false;
    sendBtn.disabled = false;
    leadCaptured = false;
    visitorName = '';
    visitorEmail = '';
    widgetToken = null;
    widgetSessionNonce = null;
    pendingClientMessageId = null;
    pendingClientMessageText = null;
    pendingLeadClientId = null;
    pendingLeadMessage = null;
    pendingLeadSourceClientMessageId = null;
    proactiveOpenedSource = null;
    widgetEngagementSource = null;
    widgetLoadedTelemetrySent = false;
    widgetEngagementTelemetrySent = false;
    firstMessageTelemetrySent = false;

    // Generate new session
    sessionId = createId();
    try {
      localStorage.setItem(storageKey, sessionId);
      localStorage.setItem(timestampKey, String(Date.now()));
    } catch(e) {}

    // Show ended message then welcome
    addMsg('Conversation ended. Feel free to start a new one!', 'bot', showQuickReplies);
    loadWidgetConfig();
  }

  function showTransientNotice(text) {
    var notice = el('div', { class: 'sa-widget-msg sa-widget-msg-bot' }, text);
    messagesArea.appendChild(notice);
    scrollToBottom();
  }

  function togglePanel() {
    if (isOpen) closePanel(true);
    else openPanel('manual');
  }

  function typeMsg(text, msgEl, callback) {
    if (prefersReducedMotion) {
      msgEl.textContent = text;
      scrollToBottom();
      if (callback) callback();
      return;
    }
    var i = 0;
    var cursor = el('span', { class: 'sa-widget-cursor' });
    msgEl.textContent = '';
    msgEl.appendChild(cursor);
    var speed = Math.max(5, Math.min(30, 1500 / (text.length || 1)));
    var timer = setInterval(function() {
      if (i < text.length) {
        if (text.charAt(i) === '\\n') {
          cursor.before(document.createElement('br'));
        } else {
          cursor.before(document.createTextNode(text.charAt(i)));
        }
        i++;
        if (i % 3 === 0) scrollToBottom();
      } else {
        clearInterval(timer);
        cursor.remove();
        scrollToBottom();
        if (callback) callback();
      }
    }, speed);
  }

  function addMsg(text, type, callback) {
    var cls = type === 'bot' ? 'sa-widget-msg sa-widget-msg-bot' : 'sa-widget-msg sa-widget-msg-user';
    var msg = el('div', { class: cls });
    if (type === 'user') {
      msg.textContent = text;
      if (config) msg.style.backgroundColor = config.brandColor;
    }
    messagesArea.appendChild(msg);
    messages.push({ text: text, type: type });
    if (type === 'bot' && !isOpen) {
      unreadCount++;
      updateLauncherIndicators();
    }
    scrollToBottom();
    if (type === 'bot') {
      typeMsg(text, msg, callback);
    } else if (callback) {
      callback();
    }
    return msg;
  }

  function showQuickReplies() {
    if (document.getElementById('sa-quick-replies')) return;
    var quickReplies = (config && config.quickReplies && config.quickReplies.length > 0)
      ? config.quickReplies
      : [];
    if (quickReplies.length === 0) return;
    var qrContainer = el('div', { class: 'sa-widget-quick-replies', id: 'sa-quick-replies' });
    quickReplies.forEach(function(q) {
      var qBtn = el('button', {
        class: 'sa-widget-quick-reply-btn',
        type: 'button',
        onClick: function() { handleQuickReply(q); }
      }, q);
      qrContainer.appendChild(qBtn);
    });
    messagesArea.appendChild(qrContainer);
    scrollToBottom();
  }

  function handleQuickReply(text) {
    var qr = document.getElementById('sa-quick-replies');
    if (qr) qr.remove();
    if (markIntentionalInteraction(true)) {
      input.value = text;
      return;
    }
    input.value = text;
    sendMessage();
  }

  function scrollToBottom() {
    setTimeout(function() { messagesArea.scrollTop = messagesArea.scrollHeight; }, 50);
  }

  function scrollToInvitationStart() {
    messagesArea.scrollTop = 0;
    setTimeout(function() { messagesArea.scrollTop = 0; }, 50);
  }

  function showLoading() {
    isLoading = true;
    petThinking = true;
    updatePetMood();
    var dots = el('div', { class: 'sa-widget-loading-dot', id: 'sa-loading' });
    messagesArea.appendChild(dots);
    scrollToBottom();
  }

  function hideLoading() {
    isLoading = false;
    petThinking = false;
    updatePetMood();
    var dots = document.getElementById('sa-loading');
    if (dots) dots.remove();
  }

  function needsLeadCapture() {
    if (!config || !config.leadCaptureEnabled || leadCaptured) return false;
    if (
      config.leadCaptureTiming === 'start' &&
      messageCount === 0 &&
      visitorIntentionalInteraction
    ) return true;
    if (config.leadCaptureTiming === 'after_3_messages' && messageCount === 3 && !leadCaptured) return true;
    return false;
  }

  function checkBookingMention(text) {
    if (!config || !config.leadCaptureEnabled || leadCaptured) return false;
    if (config.leadCaptureTiming !== 'on_booking') return false;
    return /\\b(book|booking|schedule|appointment|reserve)\\b/i.test(text);
  }

  function showLeadForm() {
    var existingForm = document.getElementById('sa-lead-form');
    if (existingForm) existingForm.remove();
    inputArea.style.display = 'none';
    var form = el('div', { class: 'sa-widget-lead-form', id: 'sa-lead-form' });
    form.appendChild(el('p', null, "We'd love to know who we're chatting with!"));
    var nameInput = el('input', { class: 'sa-widget-lead-input', placeholder: 'Your name', type: 'text', maxlength: '100' });
    var emailInput = el('input', { class: 'sa-widget-lead-input', placeholder: 'Your email', type: 'email', maxlength: '254' });
    var submitBtn = el('button', { class: 'sa-widget-lead-btn', type: 'button' }, 'Continue');
    if (config) submitBtn.style.backgroundColor = config.brandColor;
    var skipBtn = el('button', { class: 'sa-widget-lead-skip', type: 'button' }, 'Skip for now');
    submitBtn.addEventListener('click', function() {
      visitorName = nameInput.value.trim();
      visitorEmail = emailInput.value.trim();
      leadCaptured = true;
      form.remove();
      inputArea.style.display = 'flex';
      input.focus();
    });
    skipBtn.addEventListener('click', function() {
      leadCaptured = true;
      form.remove();
      inputArea.style.display = 'flex';
      input.focus();
    });
    form.appendChild(nameInput);
    form.appendChild(emailInput);
    form.appendChild(submitBtn);
    form.appendChild(skipBtn);
    panel.insertBefore(form, inputArea);
    return nameInput;
  }

  function showAssistantUnavailableLeadMode(message, sourceClientMessageId) {
    pendingClientMessageId = null;
    pendingClientMessageText = null;
    isLoading = true;
    addMsg(
      'Our assistant is unavailable right now. Leave your name or email and the business can follow up about your message.',
      'bot',
      function() {
        sendBtn.disabled = false;
        isLoading = false;
        if (!isPreview) showOfflineLeadForm(message, sourceClientMessageId);
      }
    );
  }

  function showOfflineLeadForm(message, sourceClientMessageId) {
    var existingForm = document.getElementById('sa-lead-form');
    if (existingForm) existingForm.remove();
    if (!pendingLeadClientId || pendingLeadMessage !== message) {
      pendingLeadClientId = createId();
      pendingLeadMessage = message;
      pendingLeadSourceClientMessageId = sourceClientMessageId;
    }

    inputArea.style.display = 'none';
    var form = el('div', { class: 'sa-widget-lead-form', id: 'sa-lead-form' });
    form.appendChild(el('p', null, 'Share a name or email so the business can respond.'));
    var nameInput = el('input', { class: 'sa-widget-lead-input', placeholder: 'Your name', type: 'text', maxlength: '100' });
    var emailInput = el('input', { class: 'sa-widget-lead-input', placeholder: 'Your email', type: 'email', maxlength: '254' });
    nameInput.value = visitorName;
    emailInput.value = visitorEmail;
    var status = el('p', { class: 'sa-widget-lead-status', 'aria-live': 'polite' });
    var submitBtn = el('button', { class: 'sa-widget-lead-btn', type: 'button' }, 'Send contact information');
    if (config) submitBtn.style.backgroundColor = config.brandColor;
    var skipBtn = el('button', { class: 'sa-widget-lead-skip', type: 'button' }, 'Not now');

    submitBtn.addEventListener('click', function() {
      var submittedName = nameInput.value.trim();
      var submittedEmail = emailInput.value.trim();
      status.classList.remove('sa-widget-lead-error');
      if (!submittedName && !submittedEmail) {
        status.textContent = 'Enter a name or email to continue.';
        status.classList.add('sa-widget-lead-error');
        return;
      }
      if (submittedEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(submittedEmail)) {
        status.textContent = 'Enter a valid email address.';
        status.classList.add('sa-widget-lead-error');
        return;
      }
      submitOfflineLead({
        form: form,
        nameInput: nameInput,
        emailInput: emailInput,
        status: status,
        submitBtn: submitBtn,
        skipBtn: skipBtn,
        visitorName: submittedName,
        visitorEmail: submittedEmail,
        message: message
      });
    });
    skipBtn.addEventListener('click', function() {
      leadCaptured = true;
      form.remove();
      inputArea.style.display = 'flex';
      input.focus();
    });

    form.appendChild(nameInput);
    form.appendChild(emailInput);
    form.appendChild(status);
    form.appendChild(submitBtn);
    form.appendChild(skipBtn);
    panel.insertBefore(form, inputArea);
    if (visitorName) emailInput.focus();
    else nameInput.focus();
  }

  function submitOfflineLead(fields) {
    if (!widgetToken || !widgetSessionNonce || !pendingLeadClientId || !pendingLeadSourceClientMessageId || pendingLeadMessage !== fields.message) {
      fields.status.textContent = 'We could not send your contact information. Please try again.';
      fields.status.classList.add('sa-widget-lead-error');
      loadWidgetConfig();
      return;
    }

    fields.submitBtn.disabled = true;
    fields.skipBtn.disabled = true;
    fields.nameInput.disabled = true;
    fields.emailInput.disabled = true;
    fields.status.classList.remove('sa-widget-lead-error');
    fields.status.textContent = 'Sending...';
    var leadPayload = {
      businessId: businessId,
      sessionId: sessionId,
      sessionNonce: widgetSessionNonce,
      clientLeadId: pendingLeadClientId,
      sourceClientMessageId: pendingLeadSourceClientMessageId,
      message: fields.message,
      visitorName: fields.visitorName || undefined,
      visitorEmail: fields.visitorEmail || undefined
    };

    fetch(apiBaseUrl + '/api/widget/lead?businessId=' + encodeURIComponent(businessId) + '&sessionId=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + widgetToken
      },
      body: JSON.stringify(leadPayload)
    })
    .then(function(r) {
      return r.json()
        .catch(function() { return {}; })
        .then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
    })
    .then(function(result) {
      if (!result.ok || result.data.success !== true) {
        if (result.status === 401 || result.status === 403) loadWidgetConfig();
        restoreOfflineLeadForm(fields);
        return;
      }
      visitorName = fields.visitorName;
      visitorEmail = fields.visitorEmail;
      leadCaptured = true;
      pendingLeadClientId = null;
      pendingLeadMessage = null;
      pendingLeadSourceClientMessageId = null;
      fields.form.remove();
      inputArea.style.display = 'flex';
      showTransientNotice('Thanks. Your contact information was sent to the business.');
      input.focus();
    })
    .catch(function() {
      restoreOfflineLeadForm(fields);
    });
  }

  function restoreOfflineLeadForm(fields) {
    fields.submitBtn.disabled = false;
    fields.skipBtn.disabled = false;
    fields.submitBtn.textContent = 'Try again';
    fields.status.textContent = 'We could not confirm your contact information was sent. Retry this submission or choose Not now.';
    fields.status.classList.add('sa-widget-lead-error');
  }

  function resetPreviewConversation() {
    hideLoading();
    var lf = document.getElementById('sa-lead-form');
    if (lf) lf.remove();
    messagesArea.innerHTML = '';
    messages = [];
    messageCount = 0;
    isLoading = false;
    sendBtn.disabled = false;
    leadCaptured = false;
    visitorName = '';
    visitorEmail = '';
    inputArea.style.display = 'flex';
    input.value = '';
    addMsg(config.welcomeMessage || 'Hi! How can we help you today?', 'bot', function() {
      showQuickReplies();
    });
    unreadCount = 0;
    attentionDismissed = false;
    updateLauncherIndicators();
    if (needsLeadCapture()) showLeadForm();
  }

  function applyPreviewPatch(patch) {
    if (!patch || !config) return;
    var resetMessages = false;
    var oldWelcome = config.welcomeMessage;
    var oldLeadE = config.leadCaptureEnabled;
    var oldLeadT = config.leadCaptureTiming;
    if (patch.brandColor !== undefined) {
      config.brandColor = patch.brandColor;
      applyBrandColor(patch.brandColor || '#0066FF');
      var userMsgs = messagesArea.querySelectorAll('.sa-widget-msg-user');
      for (var u = 0; u < userMsgs.length; u++) {
        userMsgs[u].style.backgroundColor = config.brandColor;
      }
    }
    if (patch.position !== undefined) {
      config.position = patch.position;
      positionWidget(patch.position);
    }
    if (patch.showLogo !== undefined) config.showLogo = patch.showLogo;
    if (patch.logoUrl !== undefined) config.logoUrl = patch.logoUrl;
    if (patch.mascotColor !== undefined) config.mascotColor = patch.mascotColor;
    applyHeaderAvatar(!!config.showLogo, config.logoUrl || '');
    applyMascotColors(config.mascotColor, config.brandColor || '#0066FF');
    if (patch.welcomeMessage !== undefined) {
      if (patch.welcomeMessage !== oldWelcome) resetMessages = true;
      config.welcomeMessage = patch.welcomeMessage;
    }
    if (patch.leadCaptureEnabled !== undefined) {
      if (patch.leadCaptureEnabled !== oldLeadE) resetMessages = true;
      config.leadCaptureEnabled = patch.leadCaptureEnabled;
    }
    if (patch.leadCaptureTiming !== undefined) {
      if (patch.leadCaptureTiming !== oldLeadT) resetMessages = true;
      config.leadCaptureTiming = patch.leadCaptureTiming;
    }
    if (patch.quickReplies !== undefined) {
      var oldQR = JSON.stringify(config.quickReplies || []);
      config.quickReplies = patch.quickReplies;
      if (JSON.stringify(patch.quickReplies) !== oldQR) resetMessages = true;
    }
    if (patch.proactiveInvitationEnabled !== undefined) {
      config.proactiveInvitationEnabled = patch.proactiveInvitationEnabled === true;
      config.proactive_invitation_enabled = patch.proactiveInvitationEnabled === true;
      if (!config.proactiveInvitationEnabled) {
        stopProactiveScheduling();
        if (proactiveAutoOpened) forcePreviewProactiveInvitation(false);
      }
    }
    if (resetMessages) resetPreviewConversation();
    if (patch.forceProactiveInvitationOpen !== undefined) {
      forcePreviewProactiveInvitation(patch.forceProactiveInvitationOpen === true);
    } else if (patch.proactiveInvitationEnabled === true) {
      forcePreviewProactiveInvitation(true);
    }
  }

  window.addEventListener('message', function(ev) {
    if (!isPreview) return;
    if (!ev.data || ev.data.source !== 'simplassist-widget-preview' || ev.data.type !== 'apply-preview') return;
    pendingPreviewPatch = ev.data.payload;
    if (config) applyPreviewPatch(pendingPreviewPatch);
  });

  function sendMessage() {
    var text = input.value.trim();
    if (!text || isLoading || !config) return;
    if (markIntentionalInteraction()) return;
    if (!isPreview && (!widgetToken || !widgetSessionNonce)) {
      loadWidgetConfig();
      showTransientNotice('The chat is reconnecting. Please try again in a moment.');
      return;
    }
    var qr = document.getElementById('sa-quick-replies'); if (qr) qr.remove();
    input.value = '';
    var userMessageEl = addMsg(text, 'user');
    endArea.style.display = '';
    messageCount++;
    try { localStorage.setItem(timestampKey, String(Date.now())); } catch(e) {}

    if (checkBookingMention(text)) {
      showLeadForm();
    }

    showLoading();
    sendBtn.disabled = true;

    if (!pendingClientMessageId || pendingClientMessageText !== text) {
      pendingClientMessageId = createId();
      pendingClientMessageText = text;
    }
    var chatPayload = {
      businessId: businessId,
      message: text,
      sessionId: sessionId,
      clientMessageId: pendingClientMessageId,
      visitorEmail: visitorEmail || undefined,
      visitorName: visitorName || undefined
    };
    if (isPreview) chatPayload.preview = true;
    else chatPayload.sessionNonce = widgetSessionNonce;

    var chatHeaders = { 'Content-Type': 'application/json' };
    if (!isPreview) chatHeaders.Authorization = 'Bearer ' + widgetToken;

    if (!isPreview && !firstMessageTelemetrySent) {
      firstMessageTelemetrySent = true;
      emitWidgetTelemetry(
        'first_message_submitted',
        widgetEngagementSource || 'manual'
      );
    }
    fetch(apiBaseUrl + '/api/widget/chat?businessId=' + encodeURIComponent(businessId) + '&sessionId=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(chatPayload)
    })
    .then(function(r) {
      return r.json()
        .catch(function() { return {}; })
        .then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
    })
    .then(function(result) {
      var data = result.data;
      hideLoading();
      if (data.available === false) {
        if (userMessageEl && userMessageEl.parentNode) userMessageEl.parentNode.removeChild(userMessageEl);
        var lastUnavailableMessage = messages[messages.length - 1];
        if (lastUnavailableMessage && lastUnavailableMessage.type === 'user' && lastUnavailableMessage.text === text) messages.pop();
        messageCount = Math.max(0, messageCount - 1);
        pendingClientMessageId = null;
        pendingClientMessageText = null;
        isLoading = false;
        sendBtn.disabled = false;
        hideWidgetForUnavailable();
        return;
      }
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) loadWidgetConfig();
        if (result.status === 401 || result.status >= 500 || data.retryable) {
          restoreTypedMessage(text, userMessageEl);
          return;
        }
        pendingClientMessageId = null;
        pendingClientMessageText = null;
        isLoading = true;
        addMsg('Sorry, that message could not be sent. Please try again.', 'bot', function() {
          sendBtn.disabled = false;
          isLoading = false;
        });
        return;
      }
      if (
        data.available === true &&
        data.response === null &&
        data.mode === 'lead_capture' &&
        data.reason === 'assistant_unavailable'
      ) {
        showAssistantUnavailableLeadMode(text, pendingClientMessageId);
        return;
      }
      isLoading = true;
      if (data.response) {
        pendingClientMessageId = null;
        pendingClientMessageText = null;
        cheerPet();
        addMsg(data.response, 'bot', function() {
          sendBtn.disabled = false;
          isLoading = false;
          messageCount++;
          if (needsLeadCapture()) showLeadForm();
        });
      } else {
        pendingClientMessageId = null;
        pendingClientMessageText = null;
        addMsg('Sorry, something went wrong. Please try again.', 'bot', function() {
          sendBtn.disabled = false;
          isLoading = false;
        });
      }
    })
    .catch(function() {
      hideLoading();
      restoreTypedMessage(text, userMessageEl);
    });
  }

  function restoreTypedMessage(text, userMessageEl) {
    if (userMessageEl && userMessageEl.parentNode) userMessageEl.parentNode.removeChild(userMessageEl);
    var lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.type === 'user' && lastMessage.text === text) messages.pop();
    messageCount = Math.max(0, messageCount - 1);
    if (messageCount === 0) endArea.style.display = 'none';
    var leadForm = document.getElementById('sa-lead-form');
    if (leadForm) leadForm.remove();
    inputArea.style.display = 'flex';
    input.value = text;
    sendBtn.disabled = false;
    isLoading = false;
    showTransientNotice("We couldn't send that message. It's back in the text box — please try again.");
    input.focus();
  }

  function validatedPoweredByUrl(value) {
    if (typeof value !== 'string' || !value || value !== value.trim()) return null;
    try {
      var parsed = new URL(value);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null;
      return parsed.href;
    } catch(e) {
      return null;
    }
  }

  function applyPoweredByAttribution(data) {
    footerLink.textContent = 'Powered by SimplAssist';
    footerLink.setAttribute('href', baseUrl + '/');

    if (typeof data.poweredByName === 'string' && data.poweredByName.trim()) {
      footerLink.textContent = 'Powered by ' + data.poweredByName.trim();
    }

    var poweredByUrl = validatedPoweredByUrl(data.poweredByUrl);
    if (poweredByUrl) footerLink.setAttribute('href', poweredByUrl);
  }

  function applyLoadedConfig(data) {
    if (!isPreview) {
      if (
        typeof data.widgetToken !== 'string' ||
        typeof data.widgetSessionNonce !== 'string' ||
        !data.widgetToken ||
        !data.widgetSessionNonce
      ) {
        hideWidgetForUnavailable();
        return;
      }
      widgetToken = data.widgetToken;
      widgetSessionNonce = data.widgetSessionNonce;
    }
    var firstLoad = !configInitialized;
    config = data;
    configInitialized = true;
    ensureHomepageRouteObserver();
    emitWidgetLoadedTelemetryIfEligible();
    applyPoweredByAttribution(data);
    titleH3.textContent = data.businessName || 'Chat';
    applyHeaderAvatar(!!data.showLogo, data.logoUrl || '');
    applyBrandColor(data.brandColor || '#0066FF');
    applyMascotColors(data.mascotColor, data.brandColor || '#0066FF');
    positionWidget(data.position || 'bottom_right');
    btn.classList.remove('sa-btn-hidden');
    btn.classList.add('sa-btn-visible');
    btn.removeAttribute('disabled');
    btn.disabled = false;
    btn.setAttribute('aria-hidden', 'false');
    btn.setAttribute('tabindex', '0');
    btn.tabIndex = 0;
    if (firstLoad) {
      addMsg(data.welcomeMessage || 'Hi! How can we help you today?', 'bot', showQuickReplies);
      unreadCount = 0;
      attentionDismissed = false;
      updateLauncherIndicators();
      if (needsLeadCapture()) showLeadForm();
    }
    if (pendingPreviewPatch) applyPreviewPatch(pendingPreviewPatch);
    if (isPreview) {
      if (
        proactiveInvitationEnabled(config) &&
        (!pendingPreviewPatch || pendingPreviewPatch.forceProactiveInvitationOpen !== false)
      ) forcePreviewProactiveInvitation(true);
    } else if (proactiveInvitationEnabled(config)) {
      startProactiveInvitation();
    } else {
      stopProactiveScheduling();
    }
    releaseHomepageRouteObserverIfIdle();
  }

  function scheduleConfigRetry() {
    if (configRetryTimer || configRetryAttempt >= CONFIG_RETRY_DELAYS.length) return;
    var delay = CONFIG_RETRY_DELAYS[configRetryAttempt++];
    configRetryTimer = setTimeout(function() {
      configRetryTimer = null;
      loadWidgetConfig();
    }, delay);
  }

  function loadWidgetConfig() {
    if (configRequestInFlight) return;
    configRequestInFlight = true;
    var configQuery = '?businessId=' + encodeURIComponent(businessId);
    if (!isPreview) configQuery += '&sessionId=' + encodeURIComponent(sessionId);
    fetch(apiBaseUrl + configPath + configQuery, { cache: 'no-store' })
      .then(function(r) {
        return r.json()
          .catch(function() { return {}; })
          .then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function(result) {
        configRequestInFlight = false;
        if (result.ok && result.data.available === false) {
          configRetryAttempt = 0;
          if (configRetryTimer) clearTimeout(configRetryTimer);
          configRetryTimer = null;
          hideWidgetForUnavailable();
          return;
        }
        if (!result.ok) {
          if (result.status >= 500 || result.data.retryable) scheduleConfigRetry();
          else hideWidgetForUnavailable();
          return;
        }
        configRetryAttempt = 0;
        if (configRetryTimer) clearTimeout(configRetryTimer);
        configRetryTimer = null;
        applyLoadedConfig(result.data);
      })
      .catch(function(err) {
        configRequestInFlight = false;
        console.error('SimplAssist: failed to load config', err);
        scheduleConfigRetry();
      });
  }

  // Initialize — hide button until config loads
  btn.classList.add('sa-btn-hidden');
  positionWidget('bottom_right');
  loadWidgetConfig();
  setInterval(loadWidgetConfig, CONFIG_REFRESH_INTERVAL);
})();`;

  return new NextResponse(js, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, no-cache, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
