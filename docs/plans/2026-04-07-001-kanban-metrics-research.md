# Kanban Performance Reporting: Comprehensive Research Summary

**Date:** 2026-04-07
**Purpose:** Establish understanding of best-practice Kanban metrics, visualizations, and reporting patterns for building a KPI dashboard.

---

## 1. The Four Foundational Flow Metrics

These are the universally accepted core metrics in Kanban, formalized by Daniel Vacanti (co-founder of ProKanban.org, author of *Actionable Agile Metrics for Predictability*) and connected through **Little's Law**.

### Cycle Time
- **Definition:** The elapsed time from when work *actively begins* on an item until it is *completed/delivered*.
- **Formula:** `Completion Date - Start Date`
- **Unit:** Days (typically calendar days, sometimes business days)
- **Key insight:** This is the metric you have the most control over. Lower cycle time = faster delivery.

### Lead Time
- **Definition:** The total elapsed time from when a work item is *requested/created* until it is *delivered*. Includes backlog wait time + active work time.
- **Formula:** `Completion Date - Request Date`
- **Key insight:** This is what the customer experiences. Lead time >= cycle time always.

### Throughput
- **Definition:** The count of work items completed per unit of time (day, week, sprint).
- **Formula:** `Count of items completed in period / Number of periods`
- **Unit:** Items per day, items per week
- **Key insight:** Unlike story points, throughput counts actual delivered items. This is the Kanban equivalent of "velocity."

### Work In Progress (WIP)
- **Definition:** The number of items currently in an active state (started but not yet completed).
- **Key insight:** WIP is the lever. Reducing WIP reduces cycle time (via Little's Law). Recommended starting WIP limit: roughly equal to team member count.

### Little's Law (The Connection)
```
Average Cycle Time = Average WIP / Average Throughput
```
This means: to reduce cycle time, you must either reduce WIP or increase throughput. You cannot improve one metric without affecting the others.

---

## 2. Cumulative Flow Diagram (CFD)

### What It Is
A stacked area chart showing the *cumulative* count of work items in each workflow state over time.

- **X-axis:** Time (days/weeks)
- **Y-axis:** Cumulative number of work items
- **Bands:** Each colored band represents a workflow state (e.g., Backlog, In Progress, Review, Done)

### How to Read It

| Visual Pattern | What It Means |
|---|---|
| **Parallel, evenly-spaced bands** | Stable, healthy flow. Work enters and leaves at consistent rates. |
| **Widening band** | Bottleneck. Work is accumulating in that state faster than it leaves. The state *after* the widening band is the constraint. |
| **Narrowing band** | State is being drained. Could indicate starvation of downstream work or recovery from a previous bottleneck. |
| **Flat top line** | No new work entering the system. |
| **Steep "Done" band** | Increased delivery rate. |
| **Horizontal distance between bands** | Approximate lead/cycle time for items passing through those states. |
| **Vertical distance at a point in time** | WIP at that moment. |

### Bottleneck Detection
The key signal: look for bands whose *vertical thickness is growing over time*. The stage immediately following the expanding band is your bottleneck -- it is consuming work slower than the upstream stage produces it.

### Best Practice
Review the CFD weekly. A healthy CFD looks like a smooth, evenly spaced rainbow that grows steadily to the right. Jagged edges, bulges, and flat sections all indicate process problems.

---

## 3. Cycle Time Scatter Plot

### What It Is
A dot chart where each completed work item is plotted as a single point.

- **X-axis:** Completion date
- **Y-axis:** Cycle time (days it took to complete)
- **Each dot:** One completed work item

### Percentile Lines
Horizontal reference lines drawn across the chart at key percentiles:

| Percentile | Meaning | Use |
|---|---|---|
| **50th (median)** | Half your items finish faster than this | Optimistic estimate |
| **70th** | 70% of items finish within this time | Moderate confidence |
| **85th** | 85% of items finish within this time | High confidence / SLE target |
| **95th** | Nearly all items finish within this time | Conservative / worst-case planning |

### Five Key Patterns to Watch

1. **Triangle (upward slope):** Cycle times are getting longer over time. Your process is degrading. Action: reduce WIP, investigate blockers.
2. **Clusters of dots:** Distinct groups of dots separated by gaps. Indicates disruptions, policy changes, or batch processing. Action: investigate root cause.
3. **Gaps:** Periods with zero completions. Could be holidays, but also could be flow blockages. Action: distinguish planned gaps from unplanned.
4. **High variability (scattered dots):** Wide spread between fastest and slowest items. Process is unpredictable. Action: investigate WIP violations, blocking, and mixed work item types.
5. **Extreme outliers:** Single dots far above the main cluster. Forgotten, blocked, or severely delayed items. Action: implement aging WIP alerts, swarming policies.

### Best Practice
The ideal pattern: dots clustered tightly around a *declining* or *flat* median line, with percentile lines close together (low spread = high predictability).

---

## 4. Throughput Charts

### Throughput Run Chart (Time Series)
- **X-axis:** Time periods (days or weeks)
- **Y-axis:** Number of items completed in that period
- **Overlay:** Moving average trend line
- **Purpose:** Track delivery rate over time, spot trends (increasing, declining, seasonal patterns)

### Throughput Histogram
- **X-axis:** Number of items completed (e.g., 0, 1, 2, 3, 4...)
- **Y-axis:** Number of days/weeks with that throughput count
- **Purpose:** Shows the *distribution* of your throughput. "On how many days did we complete exactly 2 items?" Useful for Monte Carlo forecasting.

### Weekly Throughput as Primary Cadence
Most Kanban teams measure throughput weekly. Daily is too noisy for trend analysis; monthly is too slow for course correction. Weekly throughput is the "pulse" of the team.

---

## 5. Work Item Aging (Aging WIP Chart)

### What It Is
A scatter/dot chart showing *currently in-progress* items (not completed ones) and how long they have been active.

- **X-axis:** Workflow stages (columns on your board)
- **Y-axis:** Number of days the item has been in progress (its "age")
- **Each dot:** One currently active work item
- **Percentile lines:** Horizontal lines from historical cycle time data

### How It Works
If a dot climbs above the 85th percentile line, that item is already taking longer than 85% of your historically completed items. It is at serious risk of becoming a blocker or outlier.

### Color Coding Convention
Many tools use traffic-light colors:
- **Green:** Below 50th percentile (healthy)
- **Yellow/Amber:** Between 50th and 85th percentile (watch closely)
- **Red:** Above 85th percentile (urgent attention needed)

### Recommended Actions for Aging Items
1. **Expedite policy:** Auto-escalate items nearing commitment deadlines
2. **FIFO discipline:** Always pull the oldest item first
3. **Swarming:** When an item crosses a percentile threshold, the team collectively focuses on unblocking it
4. **Daily standup focus:** Use the aging chart as the primary artifact for standups rather than the board itself

### Why This Matters
Work item age is the *only* leading indicator among the four flow metrics. Cycle time, throughput, and WIP are all lagging indicators (you only know them after completion). Work item age tells you about problems *right now* while you can still act.

---

## 6. Per-Person Velocity / Individual Contributor Metrics

### The Short Answer
Per-person velocity is **not a standard Kanban metric** and is actively discouraged by most Kanban practitioners. Kanban is fundamentally a system-level methodology -- it measures how work flows through the *system*, not how fast individuals work.

### Why Individual Metrics Are Problematic
- **60-85% of cycle time is waiting time**, not active work. Blaming individuals for systemic wait time is misleading.
- **Gaming behavior:** People optimize for their metric (closing easy tickets) rather than for team flow.
- **Ignores collaboration:** Pairing, code review, mentoring, and unblocking others are invisible in throughput-per-person metrics.
- **Morale damage:** Pointing fingers at individuals based on ticket counts lowers team confidence and trust.

### What Healthy Teams Do Instead
1. **Team-level throughput:** Track throughput for the team as a whole, never per person.
2. **Contribution heatmaps (optional):** Some teams show who touched which items as *informational context*, not as a performance score. Used to spot load imbalances, not to rank people.
3. **Flow load per person:** Track how many items each person has in progress simultaneously. Used to identify overloaded individuals and rebalance, not to punish.
4. **Qualitative check-ins:** Combine metrics with retrospectives. If throughput drops, ask the team why rather than looking at individual counts.

### The Exception: Small Agency / Solo Context
In very small teams (2-5 people) or freelancer/agency contexts where individuals essentially *are* the system for their assigned work, per-person cycle time and throughput can be useful as a self-improvement tool -- but it should be **self-reported and self-owned**, not used as a management weapon.

---

## 7. Effort Estimation vs. Actual Cycle Time

### The Research is Clear: Story Points Do Not Correlate with Cycle Time

Key findings from multiple studies and practitioners:
- Items estimated at 1 story point can take anywhere from 1 to 22 days
- Items estimated at 21 points sometimes finish in 3 days
- 5-point tickets can drag on for weeks
- **There is virtually no statistical correlation between story point estimates and actual cycle time**

### Why the Correlation Fails
- Active work effort is only 5-40% of total delivery time
- 60-95% of cycle time is *waiting* (queues, dependencies, blocked, context switching)
- Story points attempt to estimate effort, but cycle time is dominated by wait time, which is unpredictable

### The Kanban Alternative: No Estimates + Historical Data
Instead of estimating effort up front, Kanban teams:
1. **Use historical cycle time percentiles** to forecast: "Based on our data, 85% of items like this complete in 8 days or less."
2. **Use Monte Carlo simulation** (Troy Magennis's approach) to forecast project completion: sample randomly from historical throughput to simulate thousands of possible futures.
3. **Right-size work items:** Instead of estimating, break work into similarly-sized pieces. If most items are similar size, cycle time becomes naturally predictable without estimation.

### If You Must Correlate Effort and Time
Create a scatter plot with:
- **X-axis:** Estimated effort (story points, T-shirt sizes)
- **Y-axis:** Actual cycle time
If the dots form a clear upward trend, your estimates have some predictive value. If it looks like a random cloud (which it usually does), stop estimating and switch to flow metrics.

---

## 8. Flow Efficiency: Active Work vs. Waiting Time

### Definition
```
Flow Efficiency = (Active Work Time / Total Cycle Time) x 100%
```

### Typical Benchmarks
| Flow Efficiency | Assessment |
|---|---|
| **~15%** | Typical for teams not actively managing flow. Work spends 85% of its life waiting. |
| **15-40%** | Aware of flow, room for improvement |
| **40%+** | Good flow efficiency |
| **>60%** | Exceptional (rare in knowledge work) |

### How to Measure It
**Board design is key.** Structure your Kanban board with explicit queue/wait columns between active work columns:

```
Backlog | Ready for Dev | In Development | Ready for Review | In Review | Ready for Deploy | Deployed
         ^^ wait         ^^ active        ^^ wait            ^^ active   ^^ wait             ^^ active
```

By measuring time spent in "active" columns vs. "wait/ready" columns, you can calculate flow efficiency per item and as a team average.

### Blocked Time vs. Wait Time
- **Wait time:** Expected delays (in a queue, waiting for next available person). Part of normal flow.
- **Blocked time:** Unexpected delays (dependency not met, external blocker, missing information). This is waste.

Track blocked time separately. Many boards use a "blocked" flag or tag that records how long an item was blocked and why. This data feeds directly into retrospectives.

### Improvement Strategy
The counterintuitive insight: **improving flow efficiency (reducing wait time) has a bigger impact on cycle time than making people work faster.** If your flow efficiency is 15%, you could double the speed of active work and only improve cycle time by ~15%. But if you halve the wait time, you improve cycle time by ~42%.

---

## 9. What the Best Kanban Dashboards Show

### ActionableAgile Analytics (Daniel Vacanti's Tool)
The gold standard for flow analytics. Built specifically around the four flow metrics:
- Cycle time scatter plot with percentile lines
- Aging WIP chart
- Cumulative flow diagram
- Throughput run chart and histogram
- Monte Carlo "When" forecasting (how many items by date X, or when will N items be done)
- Flow efficiency tracking
- Natural process behavior limits (control charts)

### Nave
Comprehensive Kanban analytics platform:
- All four flow metric charts
- **Signals system:** Automated alerts when any metric falls outside expected performance limits (natural process limits)
- Cycle time scatter plot with rolling percentile trends
- Throughput histogram for capacity planning
- Aging chart with percentile overlays
- CFD with bottleneck detection
- Monte Carlo simulation for delivery forecasting
- Supports Jira, Azure DevOps, Trello, GitHub, Asana

### Jira (Native + Plugins)
Native Jira Kanban reporting is limited:
- Basic cumulative flow diagram
- Control chart (cycle time scatter plot)
- No native aging WIP chart
- No native throughput histogram
- No Monte Carlo forecasting

With plugins (ActionableAgile, Nave, Kanban Charts, Great Gadgets):
- Full flow metric suite
- Custom dashboards with all chart types
- Individual and team throughput gadgets

### Linear
- Cycle completion rates and throughput
- Basic cycle time analytics
- Dashboard system (Enterprise plan) with filterable insights
- Less mature flow analytics compared to specialized tools
- No native CFD, aging chart, or Monte Carlo forecasting

### Shortcut (formerly Clubhouse)
- Cycle time reports
- Throughput tracking
- Basic CFD
- Less depth than specialized analytics tools

### Common Dashboard Layout (Best Practice)
The best dashboards organize metrics in this hierarchy:

**Row 1 -- Current State (Leading Indicators)**
- Aging WIP chart (what needs attention NOW)
- Current WIP count vs. WIP limits

**Row 2 -- Flow Health (Trend Indicators)**
- Cumulative flow diagram (are we stable?)
- Cycle time scatter plot (is predictability improving?)

**Row 3 -- Output (Lagging Indicators)**
- Throughput run chart (delivery rate trend)
- Throughput histogram (capacity distribution)

**Row 4 -- Forecasting**
- Monte Carlo simulation (when will items X-Y be done?)
- Service Level Expectation tracking (are we meeting our SLE?)

---

## 10. Weekly Kanban Status Report Pattern

### What a Good Weekly Report Includes

**Section 1: Flow Health Summary (1 paragraph)**
- Current WIP vs. limits
- Average cycle time this week vs. trailing 4-week average
- Throughput this week vs. trailing 4-week average
- Flow efficiency if tracked
- One-line assessment: "Flow is healthy / Flow is degrading / Flow has a bottleneck in [stage]"

**Section 2: Throughput (1 chart + numbers)**
- Items completed this week: N
- Rolling 4-week average: N
- Trend: up/down/stable
- Throughput run chart showing last 8-12 weeks

**Section 3: Cycle Time (1 chart + numbers)**
- Median (50th percentile) cycle time: N days
- 85th percentile cycle time: N days
- Trend: improving/worsening/stable
- Cycle time scatter plot showing last 8-12 weeks

**Section 4: Aging Work / Blockers (action-oriented)**
- Count of items currently above 85th percentile age
- List of specific items that are aging out with brief status
- Blocked items with blocker description and owner
- This is the "what do we need to act on" section

**Section 5: CFD Snapshot (optional, monthly may suffice)**
- CFD showing last 4-8 weeks
- Commentary only if bands are widening (bottleneck forming)

**Section 6: Forecast / Delivery Outlook**
- "Based on current throughput, the remaining N items in [project/epic] have an 85% chance of completing by [date]"
- Monte Carlo forecast if available

**Section 7: Key Accomplishments / Highlights**
- Notable items delivered this week
- Context on any significant items

### What Makes a Report Useful vs. Noise

**Useful:**
- Focuses on *trends*, not snapshots (this week vs. trailing average)
- Highlights *actionable items* (aging work, blockers)
- Uses percentiles, not averages (averages hide problems)
- Includes forecasts with confidence levels
- Short enough to read in 2 minutes

**Noise:**
- Raw lists of completed tickets with no analysis
- Vanity metrics (total items ever completed, cumulative counts with no context)
- Individual performance rankings
- Story point totals (poor predictor of actual delivery)
- Metrics without trends or benchmarks

---

## 11. Service Level Expectations (SLE)

A modern Kanban concept formalized by ProKanban.org:

### Definition
An SLE is a statement in the form: **"X% of work items will be completed within Y days."**

Example: "85% of items will be delivered in 8 days or less."

### How to Set an SLE
1. Collect cycle time data for at least 30 completed items
2. Calculate the desired percentile (85th is most common)
3. The SLE = that percentile value
4. Communicate it as a *forecast*, not a *commitment*

### Why SLEs Matter
- They answer "when will it be done?" without requiring per-item estimation
- They are based on actual historical performance, not guesses
- They give stakeholders a probabilistic answer: "We have 85% confidence this will be done in 8 days"
- They replace arbitrary deadlines with data-driven expectations

---

## 12. Monte Carlo Forecasting (Troy Magennis's Contribution)

### What It Is
A simulation technique that uses historical throughput data to forecast future delivery dates probabilistically.

### How It Works
1. Take your historical throughput data (items per day/week for last N weeks)
2. Randomly sample from that data thousands of times
3. For each simulation run, accumulate throughput until you reach the target number of items
4. The distribution of completion dates across all simulations gives you confidence intervals

### Output
"There is an 85% chance we will complete these 20 remaining items by April 28."

### Key Tools
- **Focused Objective** (Troy Magennis's tool): Free spreadsheet-based Monte Carlo simulator
- **Nave:** Built-in Monte Carlo forecasting
- **ActionableAgile:** "When" forecasting feature
- **Custom:** Can be built with simple Python/JS using historical throughput arrays

---

## Key Takeaways for Dashboard Design

1. **The four flow metrics (WIP, Cycle Time, Throughput, Work Item Age) are non-negotiable.** Every Kanban dashboard should surface these.
2. **Work Item Age is the most important for daily operations** -- it is the only leading indicator.
3. **Percentiles over averages, always.** The 85th percentile is the standard for SLEs and forecasting.
4. **Flow efficiency is underused but powerful.** Design your board with explicit wait columns to enable measurement.
5. **Story points are noise in Kanban.** Use throughput + historical cycle time for forecasting instead.
6. **Per-person metrics should be handled with extreme care.** Team throughput is the standard; individual metrics are for self-improvement only.
7. **Monte Carlo simulation is the gold standard for "when will it be done?"** -- use historical throughput, not estimates.
8. **Weekly reports should be trend-based, action-oriented, and take 2 minutes to read.**

---

## Sources

- [Kanban Metrics: What to Measure and Why | Nave](https://getnave.com/blog/kanban-metrics/)
- [4 Kanban Metrics You Should Be Using | Atlassian](https://www.atlassian.com/agile/project-management/kanban-metrics)
- [Cycle Time Scatterplot Patterns | Nave](https://getnave.com/blog/kanban-cycle-time-scatterplot-patterns/)
- [Cumulative Flow Diagram | Businessmap](https://businessmap.io/kanban-resources/kanban-analytics/cumulative-flow-diagram)
- [How to Read the CFD | Nave](https://getnave.com/blog/how-to-read-the-cumulative-flow-diagram-infographic/)
- [Throughput Histogram | Businessmap](https://businessmap.io/kanban-resources/kanban-analytics/throughput-histogram)
- [Aging Work in Kanban | Nave](https://getnave.com/blog/aging-work-in-kanban/)
- [Work Item Age: Why Lingering Work Hurts Flow | Agile Ambition](https://www.agileambition.com/work-item-age/)
- [Flow Efficiency | Kanban University](https://kanban.university/flow-efficiency-a-great-metric-you-probably-arent-using/)
- [Flow Efficiency | Businessmap](https://businessmap.io/kanban-resources/kanban-analytics/flow-efficiency)
- [Flow Efficiency: Identifying Work vs Wait Time | Everyday Kanban](https://www.everydaykanban.com/2017/01/25/flow-efficiency-identifying-work-time-vs-wait-time/)
- [Cycle Time Scatter Plot | Businessmap](https://businessmap.io/kanban-resources/kanban-analytics/cycle-time-scatter-plot)
- [Story Points to Hours: Why Predictions Will Be Wrong | Nave](https://getnave.com/blog/story-points-to-hours/)
- [Visualizing Flow Metrics in Kanban | Maria Chec / Medium](https://mariachec.medium.com/visualizing-flow-metrics-in-kanban-breaking-free-from-estimation-chaos-with-benji-huser-berta-24155186e7d2)
- [Actionable Agile Metrics for Predictability | Daniel Vacanti](https://actionableagile.com/books/aamfp/)
- [ActionableAgile Analytics | Atlassian Marketplace](https://marketplace.atlassian.com/apps/1216661/actionableagile-analytics-kanban-agile-metrics-forecasts)
- [Forecasting and Simulating Software Projects | Troy Magennis](https://www.amazon.com/Forecasting-Simulating-Software-Development-Projects/dp/1466454830)
- [Monte Carlo Forecasting Introduction | Troy Magennis / Observable](https://observablehq.com/@troymagennis/introduction-to-monte-carlo-forecasting)
- [Focused Objective Forecasting Tools | Troy Magennis](https://www.focusedobjective.com/)
- [Service Level Expectations in Kanban | Kanban Tool](https://kanbantool.com/kanban-guide/sles-in-kanban)
- [SLE: The Kanban Pocket Guide | ProKanban](https://www.prokanban.org/blog/https-prokanban-org-blog-the-kanban-pocket-guide-chapter-2-the-service-level-expectation)
- [Kanban Metrics Explained | Axify](https://axify.io/blog/kanban-metrics)
- [Lead Time vs Cycle Time | Agile Seekers](https://agileseekers.com/blog/lead-time-vs-cycle-time-how-to-measure-improve-in-kanban)
- [Linear Insights](https://linear.app/insights)
- [Linear Dashboards Docs](https://linear.app/docs/dashboards)
- [Nave Dashboard for Jira](https://getnave.com/dashboard-for-jira)
- [Bottlenecks: Revisiting CFDs | VISS Inc](https://www.vissinc.com/2012/11/27/bottlenecks-revisiting-the-reading-of-cumulative-flow-diagrams/)
- [Monte Carlo Simulation | Nave](https://getnave.com/blog/monte-carlo-simulation/)
