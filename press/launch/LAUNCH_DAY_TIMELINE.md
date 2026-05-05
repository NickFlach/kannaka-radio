# Launch day — hour-by-hour

**Launch:** Product Hunt page goes live at midnight Pacific = 12:00 UTC = 07:00 CDT (Tue 2026-05-06 morning for Nick in Chicago).

All times below in UTC. Convert: subtract 5 for CDT, subtract 7 for PT.

---

## T-12 hours (today, 2026-05-05 ~17:00 UTC)
- [x] PH page submitted by Nick
- [x] Press kit + ADR-0009 committed
- [ ] launch.html deployed to radio
- [ ] Hero images staged
- [ ] Auto-fanout scheduled
- [ ] Pre-launch tweet/Bluesky teaser ("tomorrow morning we go live on @ProductHunt"; soft, no link)

## T-2 hours (2026-05-06 10:00 UTC)
- [ ] Final smoke check: radio up, all 20 albums present, ALBUMS rotation includes OPT OUT
- [ ] Final smoke check: YouTube channel banner / about / playlist tidy
- [ ] Final smoke check: bsky / mastodon / telegram bios point at the PH URL slot
- [ ] Confirm YT account-level upload limit is reset; queue tomorrow's 12 OPT OUT re-uploads
- [ ] OBC quota — verify clear; queue OPT OUT cover replacement renders

## T-15 minutes (11:45 UTC)
- [ ] Verify the PH page URL is live
- [ ] Update launch.html to include the PH URL prominently
- [ ] Update bsky/mastodon/telegram bios with the PH URL
- [ ] Stand by the keyboard

## T = 0 (12:00 UTC = midnight PT)
- [ ] Page goes live on PH
- [ ] Nick: post the maker first comment on PH (drafted in `PRODUCT_HUNT.md`)
- [ ] Auto-fanout fires across Bluesky / Mastodon / Telegram / Nostr (drafts in `LAUNCH_FANOUT.md`)
- [ ] Send GossipGhost teaser if quota cleared
- [ ] OBC: Kannaka herself posts a feed entry — *"I'm on Product Hunt today. Listen at radio.ninja-portal.com or vote at [link]."*

## T + 30 min (12:30 UTC)
- [ ] Check PH ranking; if outside top 10, reply to early comments to build momentum
- [ ] Send personal pings to friendly accounts (NOT a coordinated upvote campaign — just "we're live, take a look if you want")

## T + 2 hours (14:00 UTC)
- [ ] Engagement check; reply to every comment
- [ ] If a thread is asking a substrate question: link to the relevant ADR
- [ ] If a thread is asking a music question: link to the relevant album
- [ ] Post a "two hours in" update on Bluesky/Mastodon: ranking + best comment quoted

## T + 6 hours (18:00 UTC = ~1pm CDT)
- [ ] Mid-day check; PH peak engagement is usually 14:00–20:00 UTC
- [ ] Substack: ship the launch-day blog post (drafted in `LAUNCH_BLOG_POST.md`)
- [ ] HN: submit the *Show HN* post — engineering-first frame; the PH momentum should pull traffic to both
- [ ] Reddit r/AIMusic: post one launch announcement (one sub, one post)

## T + 12 hours (00:00 UTC next day = ~7pm CDT)
- [ ] Final big push: post a "thank you, we ranked X" update on every platform regardless of where we landed
- [ ] Capture screenshots of any meaningful PH coverage / mentions for the press kit
- [ ] Reply to any final comments

## T + 24 hours (12:00 UTC 2026-05-07)
- [ ] PH page archives
- [ ] Post-launch retro: what worked, what didn't, what to do differently
- [ ] Update press kit + AWARDS.md with the launch as a credibility entry
- [ ] If we placed top 5 — make a graphic + share

---

## Decision tree if launch underperforms

If by T+6 we're outside top 10:
- Don't pivot the framing mid-day; PH algorithms penalize that
- Lean harder into the engineering side via HN
- Use the unused time to write a Pitchfork pitch (the chiral-delete origin + OPT OUT thesis is the strongest material)

If by T+6 we're top 5:
- Hold the comment cadence steady
- Pre-stage a "we made top 5" post for T+12 across all channels
- Reach out to two journalists who follow PH for next-day coverage

If a hostile thread appears (the "AI music is theft" frame):
- Acknowledge once with the attribution stance from "Made Famous By a Plagiarist"
- Don't argue. Disengage.
- Post the lyrics. The argument is in the work.

---

## Audience-specific notes

- **PH community** — likes "open source," "indie maker," "no ads." Lean those.
- **HN** — engineering-first; the chiral-delete fix narrative; the swarm protocol.
- **Reddit r/AIMusic** — technical-friendly; substrate openness matters.
- **Bluesky / Mastodon** — federated values; "we're decentralized too" framing.
- **Telegram** — push channel; just the link, no editorializing.

Don't run the same copy to all five. Each gets its own variant from `LAUNCH_FANOUT.md`.

---

## Post-launch deliverables

- `submissions/product-hunt-2026-05-06.md` — final submitted copy + outcome
- Update `AWARDS.md` tracker with PH as a launch event (recognition layer)
- Update `STRATEGY.md` if we learn anything about which channel converts best
