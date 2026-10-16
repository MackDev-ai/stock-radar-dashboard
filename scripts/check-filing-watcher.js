"use strict";

const form4 = require("./lib/form4");
const { buildForm4Analysis, buildTelegramMessages } = require("./filing-watcher");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const buyXml = `<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2026-10-15</periodOfReport>
  <issuer><issuerCik>0000000001</issuerCik><issuerName>Test Power</issuerName><issuerTradingSymbol>TST</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerCik>0000000002</rptOwnerCik><rptOwnerName>DOE, JANE</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-15</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>25.50</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>8000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-14</value></transactionDate><transactionCoding><transactionCode>F</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>24</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>7000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>
  </nonDerivativeTable>
  <aff10b5One>false</aff10b5One>
</ownershipDocument>`;

const sellXml = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerName>Test Grid</issuerName><issuerTradingSymbol>SELL</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerName>SMITH JOHN</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
  <nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-10-13</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>500</value></transactionShares><transactionPricePerShare><value>40</value></transactionPricePerShare></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>9500</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></nonDerivativeTable>
  <aff10b5One>true</aff10b5One>
</ownershipDocument>`;

const buyParsed = form4.parseOwnershipXml(buyXml);
const buySummary = form4.summarizeOwnership(buyParsed);
assert(buyParsed.owners[0].officerTitle === "Chief Financial Officer", "Form 4 owner role was not parsed");
assert(buyParsed.transactions.length === 2, "Form 4 transactions were not parsed");
assert(buyParsed.transactions.some((item) => item.category === "TAX_WITHHOLDING"), "tax withholding is not distinguished from dilution");
assert(buySummary.signal === "OPEN_MARKET_BUY", "open-market purchase is not recognized");
assert(buySummary.purchaseValue === 25500, "open-market purchase value is incorrect");

const buyFiling = { ticker: "TST", name: "Test Power", form: "4", filingDate: "2026-10-16", url: "https://www.sec.gov/test" };
const buyAnalysis = buildForm4Analysis(buyParsed, buyFiling);
assert(buyAnalysis.brief.insider.hasOpenMarketTransaction === true, "structured insider market flag is missing");
assert(buyAnalysis.brief.insider.direction === "KUPNO / LONG", "purchase direction is unclear");
assert(buyAnalysis.brief.decisionBrief.verdict === "CANDIDATE", "purchase decision interpretation is missing");
assert(!/dilution|rozwodnienie/i.test(buyAnalysis.brief.summary), "tax withholding is incorrectly presented as dilution");

const sellParsed = form4.parseOwnershipXml(sellXml);
const sellAnalysis = buildForm4Analysis(sellParsed, { ...buyFiling, ticker: "SELL", name: "Test Grid" });
assert(sellAnalysis.brief.insider.direction.includes("NIE SHORT"), "Form 4 sale is incorrectly presented as a short");
assert(sellAnalysis.brief.insider.tenB5One === true, "10b5-1 flag is missing");

const messages = buildTelegramMessages({
  generatedAt: new Date().toISOString(),
  newFilings: [{ ...buyFiling, ...buyAnalysis, filingBrief: buyAnalysis.brief, filingVerdict: buyAnalysis.verdict }]
});
const output = messages.join("\n");
assert(messages.length === 1, "Form 4 Telegram fixture should fit in one message");
assert(output.includes("Transakcja rynkowa: TAK"), "Telegram does not state whether an open-market trade occurred");
assert(output.includes("Kierunek: KUPNO / LONG"), "Telegram does not state the trade direction");
assert(output.includes("Jane Doe (Chief Financial Officer, dyrektor)"), "Telegram does not identify the insider and role");
assert(output.includes("wartosc 25"), "Telegram does not include transaction value");
assert(!output.includes("typ transakcji insiderow"), "Telegram still contains the duplicated generic insider label");
assert(messages.every((message) => message.length <= 2800), "Filing Watch Telegram message exceeds its limit");

console.log("Filing Watch parser check OK: purchases, sales, tax withholding and Telegram format");
