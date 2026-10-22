// Pop sections in as they scroll into view.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// Duplicate the ticker items so the marquee loops without a gap (it scrolls by -50%).
const ticker = document.querySelector('.ticker ul');
if (ticker) {
  for (const li of [...ticker.children]) {
    const copy = li.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    ticker.appendChild(copy);
  }
}
