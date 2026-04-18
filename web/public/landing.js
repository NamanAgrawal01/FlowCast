/* ================================================================
   FLOWCAST LANDING PAGE - Interactivity
   ================================================================ */

document.addEventListener("DOMContentLoaded", () => {
    const navbar = document.getElementById("navbar");

    const handleScroll = () => {
        const currentScrollY = window.scrollY;

        if (currentScrollY > 40) {
            navbar.classList.add("scrolled");
        } else {
            navbar.classList.remove("scrolled");
        }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    const mobileMenuBtn = document.getElementById("mobile-menu-btn");
    const navLinks = document.getElementById("nav-links");

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener("click", () => {
            mobileMenuBtn.classList.toggle("active");
            navLinks.classList.toggle("open");
            document.body.style.overflow = navLinks.classList.contains("open") ? "hidden" : "";
        });

        navLinks.querySelectorAll(".nav-link").forEach((link) => {
            link.addEventListener("click", () => {
                mobileMenuBtn.classList.remove("active");
                navLinks.classList.remove("open");
                document.body.style.overflow = "";
            });
        });
    }

    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
            const targetId = anchor.getAttribute("href");
            if (targetId === "#") {
                return;
            }

            const target = document.querySelector(targetId);
            if (target) {
                event.preventDefault();
                const navHeight = navbar.offsetHeight;
                const targetPos = target.getBoundingClientRect().top + window.scrollY - navHeight - 20;

                window.scrollTo({
                    top: targetPos,
                    behavior: "smooth"
                });
            }
        });
    });

    const observerOptions = {
        root: null,
        rootMargin: "0px 0px -80px 0px",
        threshold: 0.1
    };

    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("visible");
                scrollObserver.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll(".animate-on-scroll").forEach((element) => {
        scrollObserver.observe(element);
    });

    const faqItems = document.querySelectorAll(".faq-item");

    faqItems.forEach((item) => {
        const question = item.querySelector(".faq-question");

        question.addEventListener("click", () => {
            const isActive = item.classList.contains("active");

            faqItems.forEach((other) => {
                other.classList.remove("active");
                other.querySelector(".faq-question").setAttribute("aria-expanded", "false");
            });

            if (!isActive) {
                item.classList.add("active");
                question.setAttribute("aria-expanded", "true");
            }
        });
    });

    const hero = document.querySelector(".hero");

    if (hero) {
        hero.addEventListener("mousemove", (event) => {
            const rect = hero.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * 100;
            const y = ((event.clientY - rect.top) / rect.height) * 100;
            hero.style.setProperty("--mouse-x", `${x}%`);
            hero.style.setProperty("--mouse-y", `${y}%`);
        });
    }

    const showcase = document.querySelector(".showcase-window");

    if (showcase) {
        window.addEventListener("scroll", () => {
            const rect = showcase.getBoundingClientRect();
            const scrollPercent = rect.top / window.innerHeight;

            if (scrollPercent > -0.5 && scrollPercent < 1.5) {
                const translateY = scrollPercent * 15;
                showcase.style.transform = `perspective(1000px) rotateX(${Math.max(0, translateY * 0.3)}deg)`;
            }
        }, { passive: true });
    }

    const statBars = document.querySelectorAll(".stat-bar");

    if (statBars.length > 0) {
        const animateStats = () => {
            statBars.forEach((bar) => {
                const newHeight = 30 + Math.random() * 70;
                bar.style.setProperty("--height", `${newHeight}%`);
            });
        };

        setInterval(animateStats, 2000);
    }

    const sections = document.querySelectorAll("section[id]");

    const highlightNav = () => {
        const scrollPos = window.scrollY + navbar.offsetHeight + 100;

        sections.forEach((section) => {
            const top = section.offsetTop;
            const bottom = top + section.offsetHeight;
            const id = section.getAttribute("id");
            const link = document.querySelector(`.nav-link[href="#${id}"]`);

            if (link) {
                if (scrollPos >= top && scrollPos < bottom) {
                    link.classList.add("active");
                    link.style.color = "var(--text-primary)";
                } else {
                    link.classList.remove("active");
                    link.style.color = "";
                }
            }
        });
    };

    window.addEventListener("scroll", highlightNav, { passive: true });

    const latencyEl = document.querySelector(".latency-value");

    if (latencyEl) {
        const values = ["1s", "800ms", "1.2s", "900ms", "1s"];
        let index = 0;

        setInterval(() => {
            index = (index + 1) % values.length;
            latencyEl.style.opacity = "0";

            setTimeout(() => {
                latencyEl.textContent = values[index];
                latencyEl.style.opacity = "1";
            }, 200);
        }, 3000);

        latencyEl.style.transition = "opacity 0.2s ease";
    }

    document.querySelectorAll(".download-card").forEach((card) => {
        card.addEventListener("mouseenter", (event) => {
            const rect = card.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            card.style.setProperty("--ripple-x", `${x}px`);
            card.style.setProperty("--ripple-y", `${y}px`);
        });
    });

    console.log("%cFlowCast landing page loaded", "color: #6366F1; font-weight: bold; font-size: 14px;");
});
