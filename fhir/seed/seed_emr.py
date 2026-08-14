#!/usr/bin/env python3
"""灌入符合衛福部「電子病歷交換單張實作指引（EMR IG）」的示範資料。

規格來源：https://twcore.mohw.gov.tw/ig/emr/
涵蓋單張：門診病歷（PMR）、檢驗檢查（IC）、電子處方箋（EP）、
          出院病摘（DMS）、醫療影像及報告（Image）。

用法：
    python3 fhir/seed/seed_emr.py
    python3 fhir/seed/seed_emr.py --base http://192.168.1.112:18090/fhir

所有資源都用固定 id 以 PUT 寫入，重複執行不會產生重複資料。
寫入需要 Keycloak 的 fhir-admin role，預設用 portal-admin 換 token。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

EMR = "https://twcore.mohw.gov.tw/ig/emr/StructureDefinition"
TWCORE = "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition"
CS_ICD10 = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2021-tw"
CS_FDA = "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-fda-tw"
CS_PAY = "https://twcore.mohw.gov.tw/ig/emr/CodeSystem/paymentcategory"
CS_IMGID = "https://twcore.mohw.gov.tw/ig/emr/CodeSystem/ImageIdentifierType"
CS_ICD10PCS = "https://twcore.mohw.gov.tw/ig/emr/CodeSystem/ICD-10-procedurecode"
V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203"
LOINC = "http://loinc.org"
SCT = "http://snomed.info/sct"
MOI = "http://www.moi.gov.tw"
HOSP = "https://demo-hospital.example.tw"


def profile(*names: str) -> dict:
    return {"profile": list(names)}


def cc(system: str, code: str, display: str | None = None, text: str | None = None) -> dict:
    coding = {"system": system, "code": code}
    if display:
        coding["display"] = display
    out = {"coding": [coding]}
    if text:
        out["text"] = text
    return out


def national_id(value: str) -> dict:
    """身分證字號，依 TW Core 用 NNxxx + identifier-suffix extension 標示國別。"""
    return {
        "use": "official",
        "type": {
            "coding": [
                {
                    "system": V2_0203,
                    "code": "NNxxx",
                    "_code": {
                        "extension": [
                            {
                                "url": f"{TWCORE}/identifier-suffix",
                                "extension": [
                                    {"url": "suffix", "valueString": "TWN"},
                                    {
                                        "url": "valueSet",
                                        "valueCanonical": "http://hl7.org/fhir/ValueSet/iso3166-1-3",
                                    },
                                ],
                            }
                        ]
                    },
                }
            ]
        },
        "system": MOI,
        "value": value,
    }


def medical_record_no(value: str) -> dict:
    return {
        "type": cc(V2_0203, "MR", "Medical record number"),
        "system": HOSP,
        "value": value,
    }


ORG = {
    "resourceType": "Organization",
    "id": "emr-org-1",
    "meta": profile(f"{EMR}/PMROrganization"),
    "identifier": [{"system": "https://www.nhi.gov.tw", "value": "0401180014"}],
    "active": True,
    "name": "示範醫學中心",
    "telecom": [{"system": "phone", "value": "02-23456789"}],
    "address": [
        {
            "use": "work",
            "text": "臺北市中正區中山南路 7 號",
            "city": "臺北市",
            "district": "中正區",
            "country": "TW",
        }
    ],
}

PRACTITIONERS = [
    ("emr-pra-1", "A01", "林士豪", "心臟內科"),
    ("emr-pra-2", "A02", "陳怡君", "檢驗醫學科"),
    ("emr-pra-3", "A03", "黃冠宇", "放射診斷科"),
    ("emr-pra-4", "A04", "吳孟樺", "家庭醫學科"),
]

PATIENTS = [
    {
        "id": "emr-pat-1",
        "mrn": "0000001",
        "nid": "A123456789",
        "name": "王大明",
        "gender": "male",
        "birthDate": "1958-03-12",
        "phone": "0912-345-678",
        "city": "臺北市",
        "district": "大安區",
        "line": "復興南路一段 100 號 5 樓",
    },
    {
        "id": "emr-pat-2",
        "mrn": "0000002",
        "nid": "B223456780",
        "name": "李淑芬",
        "gender": "female",
        "birthDate": "1972-11-05",
        "phone": "0922-111-222",
        "city": "新北市",
        "district": "板橋區",
        "line": "文化路二段 20 號",
    },
    {
        "id": "emr-pat-3",
        "mrn": "0000003",
        "nid": "C123456781",
        "name": "張家豪",
        "gender": "male",
        "birthDate": "1990-06-23",
        "phone": "0933-456-789",
        "city": "臺中市",
        "district": "西屯區",
        "line": "台灣大道三段 99 號",
    },
    {
        "id": "emr-pat-4",
        "mrn": "0000004",
        "nid": "D223456782",
        "name": "陳美玲",
        "gender": "female",
        "birthDate": "1949-01-30",
        "phone": "0955-888-999",
        "city": "高雄市",
        "district": "苓雅區",
        "line": "四維三路 6 號",
    },
]


def patient_resource(p: dict) -> dict:
    return {
        "resourceType": "Patient",
        "id": p["id"],
        "meta": profile(f"{EMR}/PMRPatient"),
        "identifier": [medical_record_no(p["mrn"]), national_id(p["nid"])],
        "active": True,
        "name": [{"use": "official", "text": p["name"]}],
        "telecom": [{"system": "phone", "value": p["phone"], "use": "mobile"}],
        "gender": p["gender"],
        "birthDate": p["birthDate"],
        "address": [
            {
                "use": "home",
                "text": f'{p["city"]}{p["district"]}{p["line"]}',
                "line": [p["line"]],
                "city": p["city"],
                "district": p["district"],
                "country": "TW",
            }
        ],
        "managingOrganization": {"reference": "Organization/emr-org-1"},
    }


def practitioner_resource(pid: str, code: str, name: str, dept: str) -> dict:
    return {
        "resourceType": "Practitioner",
        "id": pid,
        "meta": profile(f"{EMR}/PMRPractitioner"),
        "identifier": [
            {"use": "official", "type": cc(V2_0203, "MD"), "system": MOI, "value": code}
        ],
        "active": True,
        "name": [{"text": name}],
        "qualification": [{"code": {"text": dept}}],
    }


def encounter(eid: str, patient: str, practitioner: str, klass: str, dept: str,
              start: str, end: str | None = None, profile_name: str = "PMREncounter") -> dict:
    code = {"AMB": ("AMB", "ambulatory"), "IMP": ("IMP", "inpatient encounter"),
            "OBSENC": ("OBSENC", "observation encounter"), "EMER": ("EMER", "emergency")}[klass]
    res = {
        "resourceType": "Encounter",
        "id": eid,
        "meta": profile(f"{EMR}/{profile_name}"),
        "identifier": [{"system": HOSP, "value": eid.upper()}],
        "status": "finished",
        "class": {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            "code": code[0],
            "display": code[1],
        },
        "serviceType": cc(SCT, "394609007", text=dept),
        "subject": {"reference": f"Patient/{patient}"},
        "participant": [{"individual": {"reference": f"Practitioner/{practitioner}"}}],
        "period": {"start": start},
        "serviceProvider": {"reference": "Organization/emr-org-1"},
    }
    if end:
        res["period"]["end"] = end
    return res


def condition(cid: str, patient: str, enc: str | None, code: str, display: str,
              category: str = "diagnosis", recorded: str | None = None) -> dict:
    cat = {
        "diagnosis": cc(LOINC, "29548-5", text="診斷"),
        "major-illness": cc(LOINC, "11338-1", text="重大傷病"),
        "discharge": cc(LOINC, "11535-2", text="出院診斷"),
        "chief-complaint": cc(LOINC, "10154-3", text="主訴"),
    }[category]
    prof = {
        "diagnosis": f"{EMR}/PMRConditionDiagnosis",
        "major-illness": f"{EMR}/PMRConditionMajorIllness",
        "discharge": f"{EMR}/ConditionDMSDiagnosis",
        "chief-complaint": f"{EMR}/ConditionDMSCC",
    }[category]
    res = {
        "resourceType": "Condition",
        "id": cid,
        "meta": profile(prof),
        "clinicalStatus": cc("http://terminology.hl7.org/CodeSystem/condition-clinical", "active", "Active"),
        "verificationStatus": cc("http://terminology.hl7.org/CodeSystem/condition-ver-status", "confirmed", "Confirmed"),
        "category": [cat],
        "code": cc(CS_ICD10, code, display, text=display),
        "subject": {"reference": f"Patient/{patient}"},
    }
    if enc:
        res["encounter"] = {"reference": f"Encounter/{enc}"}
    if recorded:
        res["recordedDate"] = recorded
    return res


def lab_observation(oid: str, patient: str, enc: str | None, loinc: str, name: str,
                    when: str, performer: str, components: list[dict],
                    interpretation: tuple[str, str] | None = None,
                    specimen: str | None = None) -> dict:
    res = {
        "resourceType": "Observation",
        "id": oid,
        "meta": profile(f"{EMR}/InspectionCheckObservation"),
        "identifier": [{"system": HOSP, "value": oid.upper()}],
        "status": "final",
        "category": [cc("http://terminology.hl7.org/CodeSystem/observation-category",
                        "laboratory", "Laboratory", text="Laboratory")],
        "code": cc(LOINC, loinc, text=name),
        "subject": {"reference": f"Patient/{patient}"},
        "effectiveDateTime": when,
        "performer": [{"reference": f"Practitioner/{performer}"}],
        "component": components,
    }
    if enc:
        res["encounter"] = {"reference": f"Encounter/{enc}"}
    if interpretation:
        res["interpretation"] = [cc("http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                                    interpretation[0], text=interpretation[1])]
    if specimen:
        res["specimen"] = {"reference": f"Specimen/{specimen}"}
    return res


def component(loinc: str, name: str, value: float, unit: str, ref: str) -> dict:
    return {
        "code": cc(LOINC, loinc, text=name),
        "valueQuantity": {"value": value, "unit": unit, "system": "http://unitsofmeasure.org"},
        "referenceRange": [{"text": ref}],
    }


def medication(mid: str, fda_code: str, name: str, form_code: str, form_text: str) -> dict:
    return {
        "resourceType": "Medication",
        "id": mid,
        "meta": profile(f"{EMR}/PMRMedication"),
        "code": cc(CS_FDA, fda_code, name, text=name),
        "form": cc("http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm", form_code, text=form_text),
    }


def medication_request(rid: str, patient: str, enc: str | None, med: str, practitioner: str,
                       when: str, freq: str, freq_text: str, route_text: str,
                       dose: float, dose_unit: str, days: int, note: str) -> dict:
    res = {
        "resourceType": "MedicationRequest",
        "id": rid,
        "meta": profile(f"{EMR}/PMRMedicationRequest"),
        "identifier": [{"system": HOSP, "value": rid.upper()}],
        "status": "completed",
        "intent": "order",
        "category": [cc(LOINC, "29551-9", "Medication prescribed Narrative",
                        text="Medication prescribed Narrative")],
        "medicationReference": {"reference": f"Medication/{med}"},
        "subject": {"reference": f"Patient/{patient}"},
        "authoredOn": when,
        "requester": {"reference": f"Practitioner/{practitioner}"},
        "dosageInstruction": [
            {
                "sequence": 1,
                "text": note,
                "timing": {"code": cc("http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation",
                                      freq, freq, text=freq_text)},
                "route": cc(SCT, "26643006", "Oral route", text=route_text),
                "doseAndRate": [{"doseQuantity": {"value": dose, "unit": dose_unit}}],
            }
        ],
        "dispenseRequest": {
            "quantity": {"value": dose * days, "unit": dose_unit},
            "expectedSupplyDuration": {"value": days, "unit": "days",
                                       "system": "http://unitsofmeasure.org", "code": "d"},
        },
    }
    if enc:
        res["encounter"] = {"reference": f"Encounter/{enc}"}
    return res


def clinical_impression(cid: str, patient: str, enc: str, kind: str, text: str, when: str) -> dict:
    prof, loinc, title = {
        "S": (f"{EMR}/PMRClinicalImpressionSubjective", "61150-9", "主觀描述 Subjective"),
        "O": (f"{EMR}/PMRClinicalImpressionObjective", "61149-1", "客觀描述 Objective"),
        "A": (f"{EMR}/PMRClinicalImpressionAssessment", "11494-2", "評估 Assessment"),
    }[kind]
    return {
        "resourceType": "ClinicalImpression",
        "id": cid,
        "meta": profile(prof),
        "identifier": [{"system": LOINC, "value": loinc}],
        "status": "completed",
        "code": cc(LOINC, loinc, text=title),
        "description": text,
        "subject": {"reference": f"Patient/{patient}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "date": when,
        "summary": text,
    }


def coverage(cid: str, patient: str, code: str, display: str) -> dict:
    return {
        "resourceType": "Coverage",
        "id": cid,
        "meta": profile(f"{EMR}/Coverage-EMR"),
        "status": "active",
        "type": cc(CS_PAY, code, display),
        "beneficiary": {"reference": f"Patient/{patient}"},
        "payor": [{"reference": "Organization/emr-org-1"}],
    }


def composition(cid: str, kind: str, patient: str, enc: str, when: str, sections: list[dict],
                author_practitioner: str) -> dict:
    prof, type_code, type_display, title = {
        "PMR": (f"{EMR}/PMRComposition", "34117-2", "History and physical note", "門診病歷"),
        "IC": (f"{EMR}/InspectionCheckComposition", "11502-2", "Laboratory report", "檢驗檢查報告"),
        "DMS": (f"{EMR}/CompositionDMS", "18842-5", "Discharge summary", "出院病歷摘要"),
        "EP": (f"{EMR}/Composition-EP", "57833-6", "Prescription for medication", "電子處方箋"),
        "IMG": (f"{EMR}/ImageComposition", "18748-4", "Diagnostic imaging study", "醫療影像及報告"),
    }[kind]
    return {
        "resourceType": "Composition",
        "id": cid,
        "meta": profile(prof),
        "identifier": {"system": HOSP, "value": cid.upper()},
        "status": "final",
        "type": cc(LOINC, type_code, type_display, text=title),
        "subject": {"reference": f"Patient/{patient}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "date": when,
        "author": [{"reference": "Organization/emr-org-1"},
                   {"reference": f"Practitioner/{author_practitioner}"}],
        "title": title,
        "custodian": {"reference": "Organization/emr-org-1"},
        "section": sections,
    }


def section(title: str, loinc: str, refs: list[str]) -> dict:
    return {
        "title": title,
        "code": cc(LOINC, loinc),
        "entry": [{"reference": r} for r in refs],
    }


def build_resources() -> list[dict]:
    out: list[dict] = [ORG]
    out += [practitioner_resource(*p) for p in PRACTITIONERS]
    out += [patient_resource(p) for p in PATIENTS]

    # ---------- 王大明：高血壓 + 糖尿病門診（PMR + IC + EP） ----------
    out.append(coverage("emr-cov-1", "emr-pat-1", "4", "健保"))
    out.append(encounter("emr-enc-1", "emr-pat-1", "emr-pra-1", "AMB", "心臟內科",
                         "2026-07-14T09:20:00+08:00", "2026-07-14T09:50:00+08:00"))
    out.append(condition("emr-con-1", "emr-pat-1", "emr-enc-1", "I10", "本態性(原發性)高血壓",
                         recorded="2026-07-14"))
    out.append(condition("emr-con-2", "emr-pat-1", "emr-enc-1", "E11.9",
                         "第2型糖尿病未伴有併發症", recorded="2026-07-14"))
    out.append(condition("emr-con-3", "emr-pat-1", None, "N18.3", "慢性腎臟病第3期",
                         category="major-illness", recorded="2024-05-02"))
    out.append({
        "resourceType": "AllergyIntolerance",
        "id": "emr-alg-1",
        "meta": profile(f"{EMR}/PMRAllergyIntolerance"),
        "clinicalStatus": cc("http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                             "active", "Active"),
        "type": "allergy",
        "category": ["medication"],
        "criticality": "high",
        "code": cc(SCT, "7980007", "Penicillin", text="盤尼西林"),
        "patient": {"reference": "Patient/emr-pat-1"},
        "reaction": [{"manifestation": [cc(SCT, "247472004", text="蕁麻疹")], "severity": "moderate"}],
    })
    out.append(clinical_impression("emr-cli-1", "emr-pat-1", "emr-enc-1", "S",
                                   "近一週晨起頭暈、後頸緊繃，自量血壓約 150/95 mmHg。無胸痛、無呼吸困難。",
                                   "2026-07-14T09:25:00+08:00"))
    out.append(clinical_impression("emr-cli-2", "emr-pat-1", "emr-enc-1", "O",
                                   "BP 152/94 mmHg、HR 78 bpm、BW 78.5 kg。心音規則，無雜音；雙下肢無水腫。",
                                   "2026-07-14T09:30:00+08:00"))
    out.append(clinical_impression("emr-cli-3", "emr-pat-1", "emr-enc-1", "A",
                                   "高血壓控制不良，合併第2型糖尿病與慢性腎臟病第3期，調整降壓藥並衛教低鈉飲食。",
                                   "2026-07-14T09:40:00+08:00"))
    out.append({
        "resourceType": "Procedure",
        "id": "emr-pro-1",
        "meta": profile(f"{EMR}/PMRProcedure"),
        "status": "completed",
        "code": cc(SCT, "268400002", "12 lead ECG", text="十二導程心電圖"),
        "subject": {"reference": "Patient/emr-pat-1"},
        "encounter": {"reference": "Encounter/emr-enc-1"},
        "performedDateTime": "2026-07-14T09:35:00+08:00",
        "performer": [{"actor": {"reference": "Practitioner/emr-pra-1"}}],
    })
    out.append(medication("emr-med-1", "衛署藥製字第045678號", "Amlodipine 5mg 錠", "TAB", "錠劑"))
    out.append(medication("emr-med-2", "衛署藥製字第012345號", "Metformin 500mg 錠", "TAB", "錠劑"))
    out.append(medication_request("emr-mrq-1", "emr-pat-1", "emr-enc-1", "emr-med-1", "emr-pra-1",
                                  "2026-07-14T09:45:00+08:00", "QD", "每日一次", "口服",
                                  1, "TAB", 28, "降血壓，早餐後服用"))
    out.append(medication_request("emr-mrq-2", "emr-pat-1", "emr-enc-1", "emr-med-2", "emr-pra-1",
                                  "2026-07-14T09:45:00+08:00", "BID", "每日二次", "口服",
                                  1, "TAB", 28, "降血糖，早晚餐後服用"))
    out.append({
        "resourceType": "Specimen",
        "id": "emr-spe-1",
        "meta": profile(f"{EMR}/InspectionCheckSpecimen"),
        "status": "available",
        "type": cc(SCT, "119297000", "Blood specimen", text="靜脈全血"),
        "subject": {"reference": "Patient/emr-pat-1"},
        "collection": {
            "collectedDateTime": "2026-07-14T08:40:00+08:00",
            "bodySite": cc(SCT, "368208006", text="左上肢肘前靜脈"),
        },
    })
    out.append(encounter("emr-enc-2", "emr-pat-1", "emr-pra-2", "OBSENC", "檢驗醫學科",
                         "2026-07-14T08:40:00+08:00", profile_name="InspectionCheckEncounter"))
    out.append(lab_observation(
        "emr-obs-1", "emr-pat-1", "emr-enc-2", "58410-2", "全套血液檢查 CBC",
        "2026-07-14T08:55:00+08:00", "emr-pra-2",
        [
            component("6690-2", "白血球 WBC", 7.33, "10^3/uL", "3.8 - 10.0"),
            component("718-7", "血紅素 Hgb", 13.9, "g/dL", "13.0 - 17.0"),
            component("777-3", "血小板 Platelet", 235, "10^3/uL", "150 - 400"),
        ],
        interpretation=("N", "正常"), specimen="emr-spe-1"))
    out.append(lab_observation(
        "emr-obs-2", "emr-pat-1", "emr-enc-2", "24323-8", "生化學檢查 Biochemistry",
        "2026-07-14T08:55:00+08:00", "emr-pra-2",
        [
            component("2345-7", "飯前血糖 Glucose AC", 148, "mg/dL", "70 - 100"),
            component("4548-4", "糖化血色素 HbA1c", 7.8, "%", "4.0 - 6.0"),
            component("2160-0", "肌酸酐 Creatinine", 1.42, "mg/dL", "0.7 - 1.3"),
            component("2093-3", "總膽固醇 Cholesterol", 212, "mg/dL", "< 200"),
        ],
        interpretation=("H", "偏高"), specimen="emr-spe-1"))
    out.append(composition(
        "emr-com-pmr-1", "PMR", "emr-pat-1", "emr-enc-1", "2026-07-14T09:50:00+08:00",
        [
            section("門診病歷中的病人基本資料_重大傷病", "11338-1", ["Condition/emr-con-3"]),
            section("門診病歷中的病人基本資料_過敏史", "10155-0", ["AllergyIntolerance/emr-alg-1"]),
            section("門診病歷中的病人基本資料_就醫身分別", "63513-6", ["Coverage/emr-cov-1"]),
            section("門診病歷中的診斷", "29548-5", ["Condition/emr-con-1", "Condition/emr-con-2"]),
            section("門診病歷中的診斷病情摘要_主、客觀描述與評估", "19824-2",
                    ["ClinicalImpression/emr-cli-1", "ClinicalImpression/emr-cli-2",
                     "ClinicalImpression/emr-cli-3"]),
            section("門診病歷中的處置項目", "29554-3", ["Procedure/emr-pro-1"]),
            section("門診病歷中的處方內容", "29549-3",
                    ["MedicationRequest/emr-mrq-1", "MedicationRequest/emr-mrq-2"]),
            section("門診病歷中的實驗室檢查紀錄", "19146-0",
                    ["Observation/emr-obs-1", "Observation/emr-obs-2"]),
        ], "emr-pra-1"))
    out.append(composition(
        "emr-com-ic-1", "IC", "emr-pat-1", "emr-enc-2", "2026-07-14T09:05:00+08:00",
        [
            section("檢驗檢查中的檢驗資料", "26436-6",
                    ["Observation/emr-obs-1", "Observation/emr-obs-2"]),
            section("檢驗檢查中的檢體來源", "31208-2", ["Specimen/emr-spe-1"]),
        ], "emr-pra-2"))
    out.append(composition(
        "emr-com-ep-1", "EP", "emr-pat-1", "emr-enc-1", "2026-07-14T09:48:00+08:00",
        [
            section("電子處方箋中的診斷", "29548-5", ["Condition/emr-con-1", "Condition/emr-con-2"]),
            section("電子處方箋中的處方內容", "29549-3",
                    ["MedicationRequest/emr-mrq-1", "MedicationRequest/emr-mrq-2"]),
            section("電子處方箋中的就醫身分別", "63513-6", ["Coverage/emr-cov-1"]),
        ], "emr-pra-1"))

    # ---------- 李淑芬：胸部 X 光（Image 單張，串接 DICOM/OHIF） ----------
    out.append(coverage("emr-cov-2", "emr-pat-2", "4", "健保"))
    out.append(encounter("emr-enc-3", "emr-pat-2", "emr-pra-4", "AMB", "家庭醫學科",
                         "2026-07-20T14:10:00+08:00", "2026-07-20T14:35:00+08:00"))
    out.append(condition("emr-con-4", "emr-pat-2", "emr-enc-3", "R05", "咳嗽",
                         category="chief-complaint", recorded="2026-07-20"))
    out.append({
        "resourceType": "Endpoint",
        "id": "emr-end-1",
        "meta": profile(f"{EMR}/MitwEndpoint"),
        "status": "active",
        "connectionType": {
            "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
            "code": "dicom-wado-rs",
        },
        "name": "示範醫學中心 DICOMweb",
        "managingOrganization": {"reference": "Organization/emr-org-1"},
        "payloadType": [{"text": "DICOM"}],
        "payloadMimeType": ["application/dicom"],
        "address": "http://localhost:8088/dicom-web",
    })
    out.append({
        "resourceType": "ImagingStudy",
        "id": "emr-img-1",
        "meta": profile(f"{EMR}/ImagingStudyBase"),
        "identifier": [
            {
                "use": "official",
                "type": cc(CS_IMGID, "SIUID", "Study instance UID"),
                "system": "urn:dicom:uid",
                "value": "urn:oid:1.2.826.0.1.3680043.8.498.20260720141500",
            },
            {
                "use": "official",
                "type": cc(CS_IMGID, "ACSN", "Accession ID"),
                "system": HOSP,
                "value": "ACSN-20260720-0001",
            },
        ],
        "status": "available",
        "modality": [{"system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CR"}],
        "subject": {"reference": "Patient/emr-pat-2"},
        "encounter": {"reference": "Encounter/emr-enc-3"},
        "started": "2026-07-20T14:15:00+08:00",
        "endpoint": [{"reference": "Endpoint/emr-end-1"}],
        "numberOfSeries": 1,
        "numberOfInstances": 2,
        "procedureCode": [cc(CS_ICD10PCS, "BW03ZZZ", "Plain Radiography of Chest")],
        "description": "胸部 X 光 正面／側面",
        "series": [
            {
                "uid": "1.2.826.0.1.3680043.8.498.20260720141500.1",
                "number": 1,
                "modality": {"system": "http://dicom.nema.org/resources/ontology/DCM", "code": "CR"},
                "description": "CHEST PA/LAT",
                "numberOfInstances": 2,
                "bodySite": {"system": SCT, "code": "51185008", "display": "Thoracic structure"},
                "instance": [
                    {"uid": "1.2.826.0.1.3680043.8.498.20260720141500.1.1", "number": 1,
                     "sopClass": {"system": "urn:ietf:rfc:3986",
                                  "code": "urn:oid:1.2.840.10008.5.1.4.1.1.1"}},
                    {"uid": "1.2.826.0.1.3680043.8.498.20260720141500.1.2", "number": 2,
                     "sopClass": {"system": "urn:ietf:rfc:3986",
                                  "code": "urn:oid:1.2.840.10008.5.1.4.1.1.1"}},
                ],
            }
        ],
    })
    out.append({
        "resourceType": "Observation",
        "id": "emr-obs-3",
        "meta": profile(f"{EMR}/Observation-Imaging-Result"),
        "status": "final",
        "category": [cc("http://terminology.hl7.org/CodeSystem/observation-category",
                        "imaging", "Imaging")],
        "code": cc(CS_ICD10PCS, "BW03ZZZ", "Plain Radiography of Chest", text="胸部 X 光判讀"),
        "subject": {"reference": "Patient/emr-pat-2"},
        "effectiveDateTime": "2026-07-20T15:00:00+08:00",
        "performer": [{"reference": "Practitioner/emr-pra-3"}],
        "valueString": "兩側肺野清晰，無浸潤或實質化病灶。心臟大小正常，CT ratio 約 0.45。"
                       "兩側肋膈角銳利，無肋膜積液。縱膈腔無異常增寬。",
    })
    out.append({
        "resourceType": "DiagnosticReport",
        "id": "emr-dr-1",
        "meta": profile(f"{EMR}/DiagnosticReport-Image"),
        "identifier": [{"system": HOSP, "value": "RPT-20260720-0001"}],
        "status": "final",
        "category": [cc(LOINC, "LP29684-5", "RAD")],
        "code": cc(CS_ICD10PCS, "BW03ZZZ", "Plain Radiography of Chest", text="胸部 X 光"),
        "subject": {"reference": "Patient/emr-pat-2"},
        "encounter": {"reference": "Encounter/emr-enc-3"},
        "effectiveDateTime": "2026-07-20T14:15:00+08:00",
        "issued": "2026-07-20T15:05:00+08:00",
        "performer": [{"reference": "Practitioner/emr-pra-3"}],
        "resultsInterpreter": [{"reference": "Practitioner/emr-pra-3"}],
        "result": [{"reference": "Observation/emr-obs-3"}],
        "imagingStudy": [{"reference": "ImagingStudy/emr-img-1"}],
        "conclusion": "無急性心肺異常發現。建議症狀持續時追蹤。",
    })
    out.append(composition(
        "emr-com-img-1", "IMG", "emr-pat-2", "emr-enc-3", "2026-07-20T15:10:00+08:00",
        [
            section("醫療影像及報告中的病史", "11329-0", ["Condition/emr-con-4"]),
            section("醫療影像及報告中的醫學影像內容", "18748-4", ["ImagingStudy/emr-img-1"]),
            section("醫療影像及報告中的影像診斷結果", "18782-3", ["DiagnosticReport/emr-dr-1"]),
        ], "emr-pra-3"))

    # ---------- 張家豪：急性闌尾炎住院（DMS 出院病摘） ----------
    out.append(coverage("emr-cov-3", "emr-pat-3", "4", "健保"))
    out.append(encounter("emr-enc-4", "emr-pat-3", "emr-pra-4", "IMP", "一般外科",
                         "2026-06-02T20:30:00+08:00", "2026-06-06T11:00:00+08:00",
                         profile_name="EncounterDMS"))
    out.append(condition("emr-con-5", "emr-pat-3", "emr-enc-4", "K35.80", "急性闌尾炎",
                         category="discharge", recorded="2026-06-06"))
    out.append(condition("emr-con-6", "emr-pat-3", "emr-enc-4", "R10.31", "右下腹痛",
                         category="chief-complaint", recorded="2026-06-02"))
    out.append({
        "resourceType": "Procedure",
        "id": "emr-pro-2",
        "meta": profile(f"{EMR}/ProcedureDMSSurgicalMethod"),
        "status": "completed",
        "category": cc(SCT, "387713003", "Surgical procedure", text="手術"),
        "code": cc(SCT, "174041007", "Laparoscopic appendectomy", text="腹腔鏡闌尾切除術"),
        "subject": {"reference": "Patient/emr-pat-3"},
        "encounter": {"reference": "Encounter/emr-enc-4"},
        "performedDateTime": "2026-06-03T01:20:00+08:00",
        "performer": [{"actor": {"reference": "Practitioner/emr-pra-4"}}],
    })
    out.append({
        "resourceType": "CarePlan",
        "id": "emr-cp-1",
        "meta": profile(f"{EMR}/CarePlanInstructionDMS"),
        "status": "completed",
        "intent": "plan",
        "title": "出院指示",
        "description": "傷口每日換藥，兩週內避免提重物；出院後 7 天回一般外科門診拆線；"
                       "如出現發燒、傷口紅腫熱痛或劇烈腹痛請立即返診。",
        "subject": {"reference": "Patient/emr-pat-3"},
        "encounter": {"reference": "Encounter/emr-enc-4"},
        "period": {"start": "2026-06-06"},
    })
    out.append(lab_observation(
        "emr-obs-4", "emr-pat-3", "emr-enc-4", "58410-2", "全套血液檢查 CBC（住院）",
        "2026-06-02T21:10:00+08:00", "emr-pra-2",
        [
            component("6690-2", "白血球 WBC", 15.8, "10^3/uL", "3.8 - 10.0"),
            component("770-8", "嗜中性球比例 Neutrophils", 86.0, "%", "40 - 75"),
        ],
        interpretation=("H", "偏高")))
    out.append(composition(
        "emr-com-dms-1", "DMS", "emr-pat-3", "emr-enc-4", "2026-06-06T11:30:00+08:00",
        [
            section("出院病摘中的主訴", "10154-3", ["Condition/emr-con-6"]),
            section("出院病摘中的出院診斷", "11535-2", ["Condition/emr-con-5"]),
            section("出院病摘中的手術日期及方法", "10223-6", ["Procedure/emr-pro-2"]),
            section("出院病摘中的檢驗", "26436-6", ["Observation/emr-obs-4"]),
            section("出院病摘中的出院指示", "8653-8", ["CarePlan/emr-cp-1"]),
        ], "emr-pra-4"))

    # ---------- 陳美玲：慢性病追蹤門診 ----------
    out.append(coverage("emr-cov-4", "emr-pat-4", "4", "健保"))
    out.append(encounter("emr-enc-5", "emr-pat-4", "emr-pra-1", "AMB", "心臟內科",
                         "2026-08-04T10:05:00+08:00", "2026-08-04T10:25:00+08:00"))
    out.append(condition("emr-con-7", "emr-pat-4", "emr-enc-5", "I50.9", "心臟衰竭",
                         recorded="2026-08-04"))
    out.append(medication("emr-med-3", "衛署藥製字第098765號", "Furosemide 40mg 錠", "TAB", "錠劑"))
    out.append(medication_request("emr-mrq-3", "emr-pat-4", "emr-enc-5", "emr-med-3", "emr-pra-1",
                                  "2026-08-04T10:20:00+08:00", "QD", "每日一次", "口服",
                                  1, "TAB", 30, "利尿劑，早上服用"))
    out.append(lab_observation(
        "emr-obs-5", "emr-pat-4", "emr-enc-5", "24323-8", "生化學檢查 Biochemistry",
        "2026-08-04T09:30:00+08:00", "emr-pra-2",
        [
            component("2160-0", "肌酸酐 Creatinine", 1.10, "mg/dL", "0.6 - 1.1"),
            component("2823-3", "鉀離子 Potassium", 3.4, "mmol/L", "3.5 - 5.1"),
        ],
        interpretation=("L", "偏低")))
    out.append(composition(
        "emr-com-pmr-2", "PMR", "emr-pat-4", "emr-enc-5", "2026-08-04T10:25:00+08:00",
        [
            section("門診病歷中的診斷", "29548-5", ["Condition/emr-con-7"]),
            section("門診病歷中的處方內容", "29549-3", ["MedicationRequest/emr-mrq-3"]),
            section("門診病歷中的實驗室檢查紀錄", "19146-0", ["Observation/emr-obs-5"]),
            section("門診病歷中的病人基本資料_就醫身分別", "63513-6", ["Coverage/emr-cov-4"]),
        ], "emr-pra-1"))
    return out


def get_token(keycloak: str, realm: str, client_id: str, username: str, password: str) -> str:
    url = f"{keycloak.rstrip('/')}/realms/{realm}/protocol/openid-connect/token"
    data = urllib.parse.urlencode({
        "grant_type": "password",
        "client_id": client_id,
        "username": username,
        "password": password,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
        return json.load(r)["access_token"]


def put_resource(base: str, token: str, res: dict) -> tuple[int, str]:
    url = f"{base.rstrip('/')}/{res['resourceType']}/{res['id']}"
    req = urllib.request.Request(
        url,
        data=json.dumps(res, ensure_ascii=False).encode("utf-8"),
        method="PUT",
        headers={
            "Content-Type": "application/fhir+json; charset=UTF-8",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:18090/fhir", help="FHIR base URL")
    ap.add_argument("--keycloak", default="http://localhost:8080")
    ap.add_argument("--realm", default="dicom")
    ap.add_argument("--client-id", default="dicom-portal")
    ap.add_argument("--username", default="portal-admin")
    ap.add_argument("--password", default="portal-admin")
    ap.add_argument("--dry-run", action="store_true", help="只輸出 JSON，不寫入伺服器")
    args = ap.parse_args()

    resources = build_resources()
    if args.dry_run:
        print(json.dumps(resources, ensure_ascii=False, indent=2))
        return 0

    print(f"[1/2] 取得 Keycloak token（{args.username}）…")
    try:
        token = get_token(args.keycloak, args.realm, args.client_id, args.username, args.password)
    except Exception as exc:  # noqa: BLE001
        print(f"  取得 token 失敗：{exc}", file=sys.stderr)
        return 1

    print(f"[2/2] 寫入 {len(resources)} 筆資源到 {args.base} …")
    failed = 0
    for res in resources:
        status, body = put_resource(args.base, token, res)
        ok = status in (200, 201)
        if not ok:
            failed += 1
        print(f"  {'OK ' if ok else 'FAIL'} {status} {res['resourceType']}/{res['id']}"
              + (f"  {body}" if not ok else ""))
    print(f"\n完成：{len(resources) - failed} 成功、{failed} 失敗")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
