from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

OUT = "med-spa-launch-kit/output/pdf/meridion-med-spa-growth-plan.pdf"

navy = colors.HexColor("#0B0F19")
surface = colors.HexColor("#151E33")
violet = colors.HexColor("#4C59F7")
violet_light = colors.HexColor("#8A74FF")
ink = colors.HexColor("#F2F4F8")
muted = colors.HexColor("#B3BDD0")
green = colors.HexColor("#2ECC71")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Kicker", fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=violet_light, spaceAfter=8, letterSpacing=1.6))
styles.add(ParagraphStyle(name="TitleCustom", fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=ink, spaceAfter=12))
styles.add(ParagraphStyle(name="Deck", fontName="Helvetica", fontSize=11, leading=16, textColor=muted, spaceAfter=18))
styles.add(ParagraphStyle(name="SectionCustom", fontName="Helvetica-Bold", fontSize=17, leading=22, textColor=ink, spaceBefore=12, spaceAfter=8))
styles.add(ParagraphStyle(name="BodyCustom", fontName="Helvetica", fontSize=10, leading=15, textColor=muted, spaceAfter=7))
styles.add(ParagraphStyle(name="Metric", fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=ink))

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#273252"))
    canvas.line(0.6 * inch, 0.55 * inch, 7.9 * inch, 0.55 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(muted)
    canvas.drawString(0.6 * inch, 0.34 * inch, "MERIDION AI - MED SPA GROWTH OPERATOR")
    canvas.drawRightString(7.9 * inch, 0.34 * inch, f"Page {doc.page}")
    canvas.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=letter, rightMargin=.6*inch, leftMargin=.6*inch, topMargin=.6*inch, bottomMargin=.75*inch, title="Meridion Med Spa Growth Operator")
story = []

story += [Paragraph("MERIDION AI", styles["Kicker"]), Paragraph("Med Spa Growth Operator", styles["TitleCustom"]), Paragraph("A 20-60-90 day operating plan for turning more inquiries into attended consultations - with speed, clarity, and a measurable owner dashboard.", styles["Deck"])]

offer = [[Paragraph("THE OFFER", styles["Kicker"]), Paragraph("THE OUTCOME", styles["Kicker"])], [Paragraph("Lead-to-speed, AI scheduling concierge, reactivation, conversion assets, paid demand, and an operator dashboard.", styles["BodyCustom"]), Paragraph("More qualified consultations attended - without adding another full-time front-desk hire before the system earns it.", styles["BodyCustom"])]]
t = Table(offer, colWidths=[3.55*inch, 3.55*inch])
t.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,-1), surface), ("BOX", (0,0), (-1,-1), .75, colors.HexColor("#34446C")), ("INNERGRID", (0,0), (-1,-1), .5, colors.HexColor("#34446C")), ("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 13), ("RIGHTPADDING", (0,0), (-1,-1), 13), ("TOPPADDING", (0,0), (-1,-1), 11), ("BOTTOMPADDING", (0,0), (-1,-1), 11)]))
story += [t, Spacer(1, 18)]

for heading, body, markers in [
    ("Days 1-20: Stop the leakage", "Install tracking, map the inquiry lifecycle, and make every paid inquiry reachable quickly.", ["Source tracking, CRM stages, and call/SMS events", "Instant SMS and missed-call text-back", "Approved concierge FAQs and human escalation", "Lead-Speed Audit landing page and booking confirmation flow"]),
    ("Days 21-60: Create dependable demand", "Use the repaired conversion system to produce measurable consultation demand.", ["3-5 creator/founder ad concepts against one offer", "Consent-aware reactivation and no-show recovery", "Weekly dashboard and 30-minute operator review", "Retargeting for site visitors and video engagers"]),
    ("Days 61-90: Scale what proves itself", "Scale only after the clinic can handle the demand and unit economics are visible.", ["Increase spend on winning creative and offers", "Add service-specific pages where demand supports them", "Launch referral and review capture after attended appointments", "Build the next quarterly content and promotion calendar"]),
]:
    story += [Paragraph(heading, styles["SectionCustom"]), Paragraph(body, styles["BodyCustom"])]
    for marker in markers:
        story.append(Paragraph(f'<font color="#8A74FF">&#8226;</font> {marker}', styles["BodyCustom"]))

story += [PageBreak(), Paragraph("Owner dashboard", styles["TitleCustom"]), Paragraph("These are the numbers Meridion reviews with the owner every week. The point is not more activity; it is more attended consults from the right sources.", styles["Deck"])]

metrics = [["Metric", "Decision it enables"], ["Median first-response time", "Is lead speed actually fixed?"], ["Contact rate", "Are inquiries reachable and routed?"], ["Consult booking rate", "Is the follow-up and offer converting?"], ["Show rate", "Is calendar efficiency protected?"], ["Cost per attended consult", "Can paid demand scale responsibly?"], ["Consult-to-sale rate", "Is the handoff from marketing to clinic working?"], ["Revenue by source", "Where should the next dollar go?"]]
table = Table([[Paragraph(x, styles["Metric"] if r == 0 else styles["BodyCustom"]) for x in row] for r, row in enumerate(metrics)], colWidths=[2.4*inch, 4.7*inch])
table.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,0), violet), ("BACKGROUND", (0,1), (-1,-1), surface), ("GRID", (0,0), (-1,-1), .5, colors.HexColor("#34446C")), ("VALIGN", (0,0), (-1,-1), "MIDDLE"), ("LEFTPADDING", (0,0), (-1,-1), 12), ("RIGHTPADDING", (0,0), (-1,-1), 12), ("TOPPADDING", (0,0), (-1,-1), 9), ("BOTTOMPADDING", (0,0), (-1,-1), 9)]))
story += [table, Spacer(1, 22), Paragraph("Safety and operating boundaries", styles["SectionCustom"]), Paragraph("The concierge schedules and routes. It does not diagnose, recommend treatment, promise outcomes, or collect unnecessary sensitive information. The clinic approves offers, prices, FAQ language, consent rules, follow-up cadence, and escalation contacts before launch.", styles["BodyCustom"]), Paragraph("Next step", styles["SectionCustom"]), Paragraph("Book a 15-minute Growth Operator Call. We will audit response speed, calendar flow, and paid-lead leakage, then decide whether the Foundation or Growth Operator engagement is the right first build.", styles["BodyCustom"])]

doc.build(story, onFirstPage=footer, onLaterPages=footer)
