var navigating = false;
  function showPage(page) {
    if (navigating) return;
    navigating = true;
    window.location.href = '/' + page;
  }

  function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    menu.classList.toggle('open');
  }

  function toggleFaq(item) {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.faq-answer').style.maxHeight = '0';
    });
    if (!isOpen) {
      item.classList.add('open');
      const ans = item.querySelector('.faq-answer');
      ans.style.maxHeight = ans.scrollHeight + 'px';
    }
  }

  // ===== SCROLL EFFECTS =====
  let scrollTicking = false;
  window.addEventListener('scroll', () => {
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        const nav = document.getElementById('mainNav');
        if (window.scrollY > 30) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
        checkFades();
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  });

  function checkFades() {
    document.querySelectorAll('.fade-up:not(.visible)').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 60) el.classList.add('visible');
    });
  }

  document.body.classList.add('js-loaded');

  const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(el => { if (el.isIntersecting) { el.target.classList.add('visible'); fadeObserver.unobserve(el.target); } });
  }, { threshold: 0.05 });
  document.querySelectorAll('.fade-up').forEach(el => fadeObserver.observe(el));
  checkFades();

  window.addEventListener('load', checkFades);
  setTimeout(checkFades, 100);
  setTimeout(checkFades, 500);


  var LEGAL_CONTENT = {
    privacy: {
      title: 'Privacy Policy',
      html: `<p><strong>Effective Date: July 31, 2024</strong></p>
<p>LevelUp Pickleball Club, LLC ("us," "we," or "our") operates www.LevelUpPickleballClub.com. This Privacy Policy explains how we collect, use, disclose, and safeguard your information.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Information We Collect</h3>
<p>We may collect: first and last name, email address, phone number, mailing address, account/membership information, and payment-related identifiers (processed securely by third parties).</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">How We Use Your Information</h3>
<p>We use your information to provide and manage memberships, reservations, and services; communicate about your account or bookings; send updates, announcements, and promotions; and provide customer support. You may opt out of marketing communications at any time.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Text Message (SMS) Communications</h3>
<p>By providing your phone number and opting in, you consent to receive transactional and promotional text messages. Message and data rates may apply. Reply STOP to opt out, HELP for assistance. Consent is not a condition of purchase.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Cookies & Tracking</h3>
<p>We use cookies to operate the Service, remember preferences, improve security, and analyze usage. You may configure your browser to refuse cookies, though some features may not function properly.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Data Security</h3>
<p>We use commercially reasonable safeguards to protect your data. No method of transmission over the Internet is completely secure.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Contact Us</h3>
<p>LevelUp Pickleball Club, LLC<br>📧 info@leveluppickleballclub.com<br>🌐 www.LevelUpPickleballClub.com</p>`
    },
    terms: {
      title: 'Terms of Service',
      html: `<p>This website is operated by LevelUp Pickleball Club. By visiting our site and/or purchasing products or services, you agree to be bound by these Terms of Service.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 1 – Online Store Terms</h3>
<p>By agreeing to these Terms, you confirm you are at least the age of majority in your state or province of residence. You may not use our products or services for any illegal or unauthorized purpose.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 2 – General Conditions</h3>
<p>We reserve the right to refuse service to anyone, for any reason, at any time. You agree not to reproduce, duplicate, copy, sell, resell, or exploit any portion of the Service without our express written permission.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 3 – Accuracy of Information</h3>
<p>We are not responsible if information on this site is inaccurate, incomplete, or outdated. Content is provided for general information only.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 4 – Modifications to Service and Pricing</h3>
<p>Prices are subject to change without notice. We may modify or discontinue the Service at any time without notice.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 13 – Disclaimer & Limitation of Liability</h3>
<p>LevelUp Pickleball Club and its affiliates are not liable for any damages arising from your use of the Service.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Section 18 – Governing Law</h3>
<p>These Terms are governed by the laws of the United States.</p>
<h3 style="margin-top:1.5rem;color:var(--navy);">Contact Information</h3>
<p>Questions regarding these Terms should be sent to:<br>📧 info@leveluppickleballclub.com</p>`
    }
  };

  function showLegalModal(type) {
    var content = LEGAL_CONTENT[type];
    if (!content) return;
    document.getElementById('legalModalTitle').textContent = content.title;
    document.getElementById('legalModalContent').innerHTML = content.html;
    document.getElementById('legalModal').style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  function closeLegalModal() {
    document.getElementById('legalModal').style.display = 'none';
    document.body.style.overflow = '';
  }

  // Close on backdrop click
  document.getElementById('legalModal').addEventListener('click', function(e) {
    if (e.target === this) closeLegalModal();
  });
