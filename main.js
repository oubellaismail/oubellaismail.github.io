// Pop sections in as they scroll into view.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// ---------- Mobile menu ----------
const menuBtn = document.querySelector('.menu-btn');
const siteNav = document.getElementById('site-nav');
const setMenu = (open) => {
  siteNav.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
};
menuBtn.addEventListener('click', () => setMenu(!siteNav.classList.contains('open')));
siteNav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && siteNav.classList.contains('open')) { setMenu(false); menuBtn.focus(); }
});
document.addEventListener('click', (e) => {
  if (siteNav.classList.contains('open') && !e.target.closest('.nav')) setMenu(false);
});

// ---------- Experience: show the first two bullets, the rest on demand ----------
const VISIBLE = 2;
document.querySelectorAll('.row-main ul').forEach((list) => {
  const hidden = list.children.length - VISIBLE;
  if (hidden < 2) return; // not worth a click for a single extra bullet
  list.classList.add('collapsed');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'more-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = `+ ${hidden} more`;
  btn.addEventListener('click', () => {
    const open = list.classList.toggle('collapsed') === false;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Show less' : `+ ${hidden} more`;
  });
  list.after(btn);
});

// ---------- Highlight the nav link for the section in view ----------
const navLinks = new Map([...siteNav.querySelectorAll('a')].map((a) => [a.hash.slice(1), a]));
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    navLinks.forEach((a) => a.removeAttribute('aria-current'));
    navLinks.get(e.target.id)?.setAttribute('aria-current', 'true');
  }
}, { rootMargin: '-45% 0px -50% 0px' }); // a thin band across the middle of the screen
navLinks.forEach((_, id) => { const s = document.getElementById(id); if (s) spy.observe(s); });
const clearActive = new IntersectionObserver(([e]) => {
  if (e.isIntersecting) navLinks.forEach((a) => a.removeAttribute('aria-current'));
}, { rootMargin: '-45% 0px -50% 0px' });
clearActive.observe(document.querySelector('.hero'));

// Duplicate the ticker items so the marquee loops without a gap (it scrolls by -50%).
const ticker = document.querySelector('.ticker ul');
if (ticker) {
  for (const li of [...ticker.children]) {
    const copy = li.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    ticker.appendChild(copy);
  }
}
