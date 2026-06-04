import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import NavBar from '../components/NavBar';
import PageHeader from '../components/PageHeader';
import { PatientNameBlock } from '../components/PatientNameBlock';
import EditableChipList from '../components/EditableChipList';
import { addToOutbox, addVisit, getChild, getVisit, performSync, updateVisit, upsertChild } from '../db/indexedDB';
import { notifyError, notifySuccess } from '../utils/notify';
import { toYmd, ymdToIsoUtc8 } from '../utils/dates';
import {
  computeFollowUpDueAt,
  FOLLOW_UP_CUSTOM_DAYS,
  FOLLOW_UP_FORM_OPTIONS,
  FOLLOW_UP_WITHIN_7_DAYS,
  normalizeFollowUpTiming,
  resolveFollowUpDays,
  visitFollowUpToForm
} from '../utils/followUpTiming';
import {
  CONDITIONS,
  permanentTeeth,
  primaryTeeth,
  PERMANENT_SET,
  PRIMARY_SET,
  isDarkHex,
  getPersistedToothCondition
} from '../utils/toothChart';

const PRESET_SYMPTOMS = ['Pain', 'Swelling', 'Bleeding', 'Sensitivity'];

const SYMPTOM_DAY_DEFAULT = 1;
const clampSymptomDays = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return SYMPTOM_DAY_DEFAULT;
  return Math.min(365, Math.max(1, n));
};

/** Persist / server: empty or invalid → default 1 */
const normalizeSymptomDaysForSave = (v) => {
  if (v === '' || v == null) return SYMPTOM_DAY_DEFAULT;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return SYMPTOM_DAY_DEFAULT;
  return Math.min(365, Math.max(1, n));
};

const GENERAL_TREATMENTS = ['Cleaning', 'Fluoride'];
const COMMON_TREATMENTS = ['Cleaning', 'Fluoride', 'Sealant', 'Filling', 'Extraction'];

const TREATMENT_COLORS = {
  Cleaning: '#10b981',
  Fluoride: '#8b5cf6',
  Sealant: '#f59e0b',
  Filling: '#3b82f6',
  Extraction: '#ef4444'
};
const COMMON_MEDS = ['Amoxicillin', 'Ibuprofen', 'Paracetamol', 'Mefenamic', 'Co-amox'];

const btnAddGreen = {
  background: '#16a34a',
  color: '#fff',
  border: '1px solid #15803d',
  fontWeight: 700
};

const normToothRecord = (raw) => {
  if (raw == null) return { condition: 'sound', note: '' };
  if (typeof raw === 'string') return { condition: raw || 'sound', note: '' };
  return {
    condition: raw.condition || 'sound',
    note: raw.note != null ? String(raw.note) : ''
  };
};

/** Hydrate examination + treatment form state from any visit shape (legacy included). */
function visitToFormExamAndTreatment(visit) {
  const toothRecords = {};
  const toothSpecificByTooth = {};

  const recs = visit?.toothRecords;
  if (recs && typeof recs === 'object' && !Array.isArray(recs)) {
    for (const [k, v] of Object.entries(recs)) {
      toothRecords[String(k)] = normToothRecord(v);
    }
  }

  const exams = visit?.toothExaminations;
  if (Array.isArray(exams)) {
    for (const ex of exams) {
      if (!ex || typeof ex !== 'object' || !ex.toothNumber) continue;
      const t = String(ex.toothNumber);
      const prev = toothRecords[t] || { condition: 'sound', note: '' };
      toothRecords[t] = {
        condition: ex.condition != null && ex.condition !== '' ? ex.condition : prev.condition,
        note: ex.note != null ? String(ex.note) : prev.note
      };
      if (Array.isArray(ex.treatments) && ex.treatments.length) {
        toothSpecificByTooth[t] = [
          ...new Set([...(toothSpecificByTooth[t] || []), ...ex.treatments.map(String)])
        ];
      }
    }
  }

  if (Array.isArray(visit?.toothSpecificTreatments) && visit.toothSpecificTreatments.length > 0) {
    for (const row of visit.toothSpecificTreatments) {
      if (!row?.toothNumber) continue;
      const t = String(row.toothNumber);
      const tr = Array.isArray(row.treatments) ? row.treatments : [];
      toothSpecificByTooth[t] = [
        ...new Set([...(toothSpecificByTooth[t] || []), ...tr.map(String)])
      ];
    }
  }

  const generalTreatments = [];
  const tt = Array.isArray(visit?.treatmentTypes) ? visit.treatmentTypes : [];
  for (const x of tt) {
    const s = String(x);
    const tm = s.match(/^Tooth\s+([^:]+):\s*(.+)$/i);
    if (tm) {
      const tooth = tm[1].trim();
      const inner = tm[2].trim();
      toothSpecificByTooth[tooth] = toothSpecificByTooth[tooth] || [];
      if (!toothSpecificByTooth[tooth].includes(inner)) toothSpecificByTooth[tooth].push(inner);
      continue;
    }
    if (!generalTreatments.includes(s)) generalTreatments.push(s);
  }

  const examinationNotes =
    visit?.examinationNotes != null && String(visit.examinationNotes).trim() !== ''
      ? String(visit.examinationNotes)
      : '';

  return { toothRecords, examinationNotes, generalTreatments, toothSpecificByTooth };
}

const countConditions = (recordsObj) => {
  const records = recordsObj && typeof recordsObj === 'object' ? Object.values(recordsObj) : [];
  let decayed = 0;
  let missing = 0;
  let filled = 0;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.condition === 'decayed') decayed += 1;
    if (r.condition === 'missing') missing += 1;
    if (r.condition === 'filled') filled += 1;
  }
  return { decayed, missing, filled };
};

const visitToSymptoms = (visit) => {
  const sym = visit.symptoms;
  if (sym && typeof sym === 'object' && Object.keys(sym).length > 0) {
    return Object.fromEntries(Object.entries(sym).map(([k, v]) => [k, clampSymptomDays(v)]));
  }
  const s = {};
  if (visit.painFlag) s.Pain = SYMPTOM_DAY_DEFAULT;
  if (visit.swellingFlag) s.Swelling = SYMPTOM_DAY_DEFAULT;
  return s;
};

const inferDentitionFromVisit = (visit) => {
  if (visit.dentition === 'PRIMARY' || visit.dentition === 'PERMANENT') return visit.dentition;
  const nums = [];
  const exams = visit.toothExaminations;
  if (Array.isArray(exams)) {
    for (const ex of exams) {
      if (ex?.toothNumber) nums.push(ex.toothNumber);
    }
  }
  const recs = visit.toothRecords;
  if (recs && typeof recs === 'object' && !Array.isArray(recs)) {
    nums.push(...Object.keys(recs));
  }
  for (const t of nums) {
    if (PRIMARY_SET.has(t)) return 'PRIMARY';
    if (PERMANENT_SET.has(t)) return 'PERMANENT';
  }
  return 'PERMANENT';
};

const normalizeMedicationsForForm = (raw) => {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return normalizeMedicationsForForm(p);
    } catch (_) {
      return [{ name: t, dosage: '', frequencyPerDay: '', days: '' }];
    }
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (item == null) return null;
        if (typeof item === 'string') {
          const n = item.trim();
          return n
            ? { name: n, dosage: '', frequencyPerDay: '', days: '' }
            : null;
        }
        if (typeof item === 'object') {
          return {
            name: item.name != null ? String(item.name) : '',
            dosage: item.dosage != null ? String(item.dosage) : '',
            frequencyPerDay:
              item.frequencyPerDay != null ? String(item.frequencyPerDay) : '',
            days: item.days != null ? String(item.days) : ''
          };
        }
        return null;
      })
      .filter((m) => m && (m.name || '').trim() !== '');
  }
  return [];
};

export default function AddVisit({ token }) {
  const { childId, visitId: editVisitIdParam } = useParams();
  const navigate = useNavigate();
  const isEditMode = Boolean(editVisitIdParam);
  const [child, setChild] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [visitLoadError, setVisitLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [date, setDate] = useState(() => toYmd(new Date()));

  const [symptoms, setSymptoms] = useState({});

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [visitNotes, setVisitNotes] = useState('');
  const [behaviourFrankl, setBehaviourFrankl] = useState('');
  const [requiresFollowUp, setRequiresFollowUp] = useState(false);
  const [followUpPriority, setFollowUpPriority] = useState(FOLLOW_UP_WITHIN_7_DAYS);
  const [followUpCustomDays, setFollowUpCustomDays] = useState('14');

  const [dentition, setDentition] = useState('PERMANENT');
  const [toothRecords, setToothRecords] = useState({});
  const [examinationNotes, setExaminationNotes] = useState('');
  const [selectedExamTooth, setSelectedExamTooth] = useState(null);

  const [generalTreatments, setGeneralTreatments] = useState([]);
  const [toothTreatments, setToothTreatments] = useState({});
  const [activeTreatment, setActiveTreatment] = useState(null);

  const [medications, setMedications] = useState([]);
  const [medDraft, setMedDraft] = useState({
    name: '',
    dosage: '',
    frequencyPerDay: '',
    days: ''
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setInitializing(true);
      setVisitLoadError('');
      setError('');
      const c = await getChild(childId);
      if (cancelled) return;
      if (!c) {
        setChild(null);
        setInitializing(false);
        setVisitLoadError('Patient not found.');
        return;
      }
      setChild(c);

      if (!editVisitIdParam) {
        setDate(toYmd(new Date()));
        setSymptoms({});
        setChiefComplaint('');
        setVisitNotes('');
        setDentition('PERMANENT');
        setToothRecords({});
        setExaminationNotes('');
        setSelectedExamTooth(null);
        setGeneralTreatments([]);
        setToothTreatments({});
        setActiveTreatment(null);
        setMedications([]);
        setMedDraft({ name: '', dosage: '', frequencyPerDay: '', days: '' });
        setBehaviourFrankl('');
        setRequiresFollowUp(false);
        setFollowUpPriority('P2');
        setInitializing(false);
        return;
      }

      const v = await getVisit(editVisitIdParam);
      if (cancelled) return;
      if (!v || v.childId !== childId) {
        setVisitLoadError('Visit not found.');
        setInitializing(false);
        return;
      }

      setDate(toYmd(v.date));
      setSymptoms(visitToSymptoms(v));
      setChiefComplaint(v.chiefComplaint != null ? String(v.chiefComplaint) : '');
      setVisitNotes(v.notes != null ? String(v.notes) : '');
      setDentition(inferDentitionFromVisit(v));
      const hydrated = visitToFormExamAndTreatment(v);
      setToothRecords(hydrated.toothRecords);
      setExaminationNotes(hydrated.examinationNotes);
      setGeneralTreatments(hydrated.generalTreatments);
      setToothTreatments(hydrated.toothSpecificByTooth);
      setActiveTreatment(null);
      setSelectedExamTooth(null);
      setMedications(normalizeMedicationsForForm(v.medications));
      setMedDraft({ name: '', dosage: '', frequencyPerDay: '', days: '' });
      setBehaviourFrankl(v.behaviourFrankl != null && v.behaviourFrankl !== '' ? String(v.behaviourFrankl) : '');
      setRequiresFollowUp(v.requiresFollowUp === true || v.requiresFollowUp === 'true');
      const fuForm = visitFollowUpToForm(v.followUpPriority, v.followUpDays);
      setFollowUpPriority(fuForm.priority);
      setFollowUpCustomDays(fuForm.customDays);
      setInitializing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [childId, editVisitIdParam]);

  const toothGrid = useMemo(() => (dentition === 'PERMANENT' ? permanentTeeth : primaryTeeth), [dentition]);

  const symptomActiveMap = useMemo(
    () => Object.fromEntries(Object.keys(symptoms).map((k) => [k, true])),
    [symptoms]
  );

  const generalTreatmentActiveMap = useMemo(
    () => Object.fromEntries(generalTreatments.map((k) => [k, true])),
    [generalTreatments]
  );

  const setDentitionSafe = (next) => {
    if (next === dentition) return;
    const ok = window.confirm('Switching dentition will clear examination and tooth-specific treatments. Continue?');
    if (!ok) return;
    setDentition(next);
    setToothRecords({});
    setToothTreatments({});
    setActiveTreatment(null);
    setSelectedExamTooth(null);
  };

  const toggleSymptom = (name) => {
    setSymptoms((prev) => {
      const next = { ...prev };
      if (next[name] != null) delete next[name];
      else next[name] = SYMPTOM_DAY_DEFAULT;
      return next;
    });
  };

  const setExamCondition = (conditionId) => {
    if (!selectedExamTooth) return;
    setToothRecords((prev) => ({
      ...prev,
      [selectedExamTooth]: {
        ...(prev[selectedExamTooth] || { condition: 'sound', note: '' }),
        condition: conditionId
      }
    }));
  };

  const setExamToothNote = (note) => {
    if (!selectedExamTooth) return;
    setToothRecords((prev) => ({
      ...prev,
      [selectedExamTooth]: {
        ...(prev[selectedExamTooth] || { condition: 'sound', note: '' }),
        note
      }
    }));
  };

  const toggleGeneralTreatment = (name) => {
    setGeneralTreatments((prev) => {
      const has = prev.includes(name);
      if (has) return prev.filter((x) => x !== name);
      return [...prev, name];
    });
  };

  const handleTreatToothClick = (tooth) => {
    if (activeTreatment) {
      // With an active treatment selected: toggle that specific treatment on the tooth
      setToothTreatments((prev) => {
        const cur = [...(prev[tooth] || [])];
        const i = cur.indexOf(activeTreatment);
        if (i >= 0) cur.splice(i, 1);
        else cur.push(activeTreatment);
        return { ...prev, [tooth]: cur };
      });
    } else {
      // No active treatment: toggle the tooth selection entirely
      setToothTreatments((prev) => {
        const next = { ...prev };
        if (next[tooth]) delete next[tooth];
        else next[tooth] = [];
        return next;
      });
    }
    // Always ensure a toothRecord entry exists
    setToothRecords((prev) => {
      if (prev[tooth]) return prev;
      const persistedId = getPersistedToothCondition(child?.toothStates, tooth);
      return { ...prev, [tooth]: { condition: persistedId || 'sound', note: '' } };
    });
  };

  const removeTreatTooth = (tooth) => {
    setToothTreatments((prev) => {
      const next = { ...prev };
      delete next[tooth];
      return next;
    });
  };

  const applyQuickMed = (name) => {
    setMedDraft((d) => ({ ...d, name }));
  };

  const addMedicationFromDraft = () => {
    const name = medDraft.name.trim();
    if (!name) {
      notifyError('Enter a medication name first.');
      return;
    }
    setMedications((prev) => [
      ...prev,
      {
        name,
        dosage: medDraft.dosage.trim() || null,
        frequencyPerDay: medDraft.frequencyPerDay.trim() || null,
        days: medDraft.days.trim() || null
      }
    ]);
    setMedDraft({ name: '', dosage: '', frequencyPerDay: '', days: '' });
  };

  const removeMedicationAt = (idx) => {
    setMedications((prev) => prev.filter((_, i) => i !== idx));
  };

  const renderExamToothButton = (tooth) => {
    const persistedId = getPersistedToothCondition(child?.toothStates, tooth);
    const examRec = toothRecords[tooth];
    const condId = examRec?.condition ?? persistedId;
    const condMeta = CONDITIONS.find((c) => c.id === condId) || CONDITIONS[0];
    const isSel = selectedExamTooth === tooth;
    const showStatusLabel = condMeta.id !== 'sound';
    const bg = condMeta.color;
    const fg = isDarkHex(condMeta.color) ? '#fff' : '#111827';
    return (
      <button
        key={`exam-${tooth}`}
        type="button"
        onClick={() => {
          setSelectedExamTooth(tooth);
          setToothRecords((prev) => {
            if (prev[tooth]) return prev;
            return {
              ...prev,
              [tooth]: { condition: persistedId || 'sound', note: '' }
            };
          });
        }}
        style={{
          padding: '8px 4px 6px',
          borderRadius: '10px',
          border: isSel ? '3px solid #111827' : '1px solid #e5e5ea',
          boxSizing: 'border-box',
          background: bg,
          color: fg,
          fontWeight: 800,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '2px',
          minHeight: '52px',
          lineHeight: 1.1
        }}
        title={showStatusLabel ? `${tooth} · ${condMeta.label}` : `${tooth}`}
      >
        <span style={{ fontSize: '0.95rem' }}>{tooth}</span>
        <span
          style={{
            fontSize: '0.62rem',
            fontWeight: 650,
            opacity: 0.92,
            textAlign: 'center',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {showStatusLabel ? condMeta.label : '\u00A0'}
        </span>
      </button>
    );
  };

  const renderTreatToothButton = (tooth) => {
    const persistedId = getPersistedToothCondition(child?.toothStates, tooth);
    const examRec = toothRecords[tooth];
    const condId = examRec?.condition ?? persistedId;
    const condMeta = CONDITIONS.find((c) => c.id === condId) || CONDITIONS[0];
    const treatments = toothTreatments[tooth];
    const isSel = treatments !== undefined;
    const primaryTreatment = Array.isArray(treatments) && treatments.length > 0 ? treatments[0] : null;
    const primaryColor = primaryTreatment ? TREATMENT_COLORS[primaryTreatment] || '#2563eb' : '#2563eb';
    const treatmentDots = Array.isArray(treatments) ? treatments : [];
    const hasTreatments = treatmentDots.length > 0;
    const bg = hasTreatments ? primaryColor : condMeta.color;
    const fg = isDarkHex(bg) ? '#fff' : '#111827';
    const secondaryTreatments = hasTreatments ? treatmentDots.slice(1) : [];
    const statusLabel = hasTreatments
      ? (treatmentDots.length === 1 ? primaryTreatment : `${treatmentDots.length} ops`)
      : (condMeta.id !== 'sound' ? condMeta.label : ' ');
    return (
      <button
        key={`treat-${tooth}`}
        type="button"
        onClick={() => handleTreatToothClick(tooth)}
        style={{
          padding: '8px 4px 4px',
          borderRadius: '10px',
          border: isSel ? `3px solid ${primaryColor}` : '1px solid #e5e5ea',
          boxSizing: 'border-box',
          background: bg,
          color: fg,
          fontWeight: 800,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1px',
          minHeight: '52px',
          lineHeight: 1.1,
          position: 'relative',
          transition: 'background 0.2s, border 0.2s'
        }}
        title={
          isSel && treatmentDots.length > 0
            ? `${tooth}: ${treatmentDots.join(', ')}`
            : isSel ? `${tooth} · selected` : `${tooth}`
        }
      >
        <span style={{ fontSize: '0.95rem' }}>{tooth}</span>
        <span
          style={{
            fontSize: '0.62rem',
            fontWeight: 650,
            opacity: 0.92,
            textAlign: 'center',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {statusLabel}
        </span>
        {secondaryTreatments.length > 0 && (
          <div style={{ display: 'flex', gap: '2px', marginTop: 1 }}>
            {secondaryTreatments.map((t, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: TREATMENT_COLORS[t] || '#999'
                }}
                title={t}
              />
            ))}
          </div>
        )}
        {isSel && treatmentDots.length <= 1 && (
          <div style={{ marginTop: 1, height: 6 }} />
        )}
      </button>
    );
  };

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const username = localStorage.getItem('username') || 'unknown';

      const toothSpecificByTooth = toothTreatments;
      const toothSpecificTreatments = Object.entries(toothSpecificByTooth)
        .filter(([, arr]) => Array.isArray(arr) && arr.length > 0)
        .map(([toothNumber, treatments]) => ({ toothNumber, treatments: [...treatments] }));

      const mergedRecords = { ...toothRecords };
      for (const row of toothSpecificTreatments) {
        if (!mergedRecords[row.toothNumber]) {
          mergedRecords[row.toothNumber] = { condition: 'sound', note: '' };
        }
      }

      const counts = countConditions(mergedRecords);
      const symptomsForSave = Object.fromEntries(
        Object.entries(symptoms).map(([k, v]) => [k, normalizeSymptomDaysForSave(v)])
      );
      const painFlag = symptomsForSave.Pain != null;
      const swellingFlag = symptomsForSave.Swelling != null;

      const toothPrefixed = toothSpecificTreatments.flatMap(({ toothNumber, treatments }) =>
        treatments.map((t) => `Tooth ${toothNumber}: ${t}`)
      );
      const treatmentTypes = [...generalTreatments, ...toothPrefixed];
      const allTreatments = [
        ...new Set([...generalTreatments, ...toothSpecificTreatments.flatMap((x) => x.treatments)])
      ];

      const toothExaminations = Object.keys(mergedRecords)
        .sort()
        .map((toothNumber) => ({
          toothNumber,
          condition: mergedRecords[toothNumber].condition,
          note: mergedRecords[toothNumber].note?.trim() || null,
          treatments: toothSpecificByTooth[toothNumber] || []
        }));

      const medicationsListed = medications.map((m) => ({
        name: m.name,
        dosage: m.dosage,
        frequencyPerDay: m.frequencyPerDay,
        days: m.days
      }));
      const draftMedName = medDraft.name.trim();
      const medicationsForSave = [...medicationsListed];
      if (draftMedName) {
        const draftRow = {
          name: draftMedName,
          dosage: medDraft.dosage.trim() || null,
          frequencyPerDay: medDraft.frequencyPerDay.trim() || null,
          days: medDraft.days.trim() || null
        };
        const alreadyHave = medicationsListed.some(
          (m) =>
            (m.name || '').trim() === draftRow.name &&
            (m.dosage || '') === (draftRow.dosage || '') &&
            (m.frequencyPerDay || '') === (draftRow.frequencyPerDay || '') &&
            (m.days || '') === (draftRow.days || '')
        );
        if (!alreadyHave) medicationsForSave.push(draftRow);
      }

      const dateIso = ymdToIsoUtc8(date) || new Date(date).toISOString();
      const notesForSave = visitNotes.trim() || null;
      const examinationNotesForSave = examinationNotes.trim() || null;
      const behaviourFranklForSave = behaviourFrankl !== '' ? Number(behaviourFrankl) : null;

      const followUpTiming = requiresFollowUp ? normalizeFollowUpTiming(followUpPriority) : null;
      const followUpDaysSaved =
        requiresFollowUp && followUpTiming === FOLLOW_UP_CUSTOM_DAYS
          ? resolveFollowUpDays(followUpTiming, followUpCustomDays)
          : null;
      const followUpDueAtSaved = requiresFollowUp
        ? computeFollowUpDueAt(dateIso, followUpTiming, followUpDaysSaved)
        : null;

      let visitData;
      if (isEditMode) {
        const existing = await getVisit(editVisitIdParam);
        if (!existing || existing.childId !== childId) {
          throw new Error('Visit not found');
        }
        visitData = {
          ...existing,
          visitId: existing.visitId,
          childId,
          date: dateIso,
          painFlag,
          swellingFlag,
          decayedTeeth: counts.decayed,
          missingTeeth: counts.missing,
          filledTeeth: counts.filled,
          chiefComplaint: chiefComplaint.trim() || null,
          symptoms: symptomsForSave,
          dentition,
          toothRecords: mergedRecords,
          toothExaminations,
          examinationNotes: examinationNotesForSave,
          toothSpecificTreatments,
          treatments: allTreatments,
          treatmentTypes,
          medications: medicationsForSave,
          notes: notesForSave,
          behaviourFrankl: behaviourFranklForSave,
          requiresFollowUp: Boolean(requiresFollowUp),
          followUpPriority: followUpTiming,
          followUpDays: followUpDaysSaved,
          followUpDueAt: followUpDueAtSaved,
          createdBy: existing.createdBy || username,
          createdAt: existing.createdAt || now,
          updatedBy: username,
          updatedAt: now
        };
        await updateVisit(visitData);
        await addToOutbox('UPDATE_VISIT', visitData.visitId, visitData);
      } else {
        const visitId = `visit-${crypto.randomUUID()}`;
        visitData = {
          visitId,
          childId,
          date: dateIso,
          painFlag,
          swellingFlag,
          decayedTeeth: counts.decayed,
          missingTeeth: counts.missing,
          filledTeeth: counts.filled,
          chiefComplaint: chiefComplaint.trim() || null,
          symptoms: symptomsForSave,
          dentition,
          toothRecords: mergedRecords,
          toothExaminations,
          examinationNotes: examinationNotesForSave,
          toothSpecificTreatments,
          treatments: allTreatments,
          treatmentTypes,
          medications: medicationsForSave,
          notes: notesForSave,
          behaviourFrankl: behaviourFranklForSave,
          requiresFollowUp: Boolean(requiresFollowUp),
          followUpPriority: followUpTiming,
          followUpDays: followUpDaysSaved,
          followUpDueAt: followUpDueAtSaved,
          createdBy: username,
          createdAt: now
        };
        await addVisit(visitData);
        await addToOutbox('ADD_VISIT', visitId, visitData);
      }

      const latestChild = await getChild(childId);
      if (latestChild && Object.keys(mergedRecords).length > 0) {
        const prevTooth =
          latestChild.toothStates != null && typeof latestChild.toothStates === 'object'
            ? { ...latestChild.toothStates }
            : {};
        for (const [t, rec] of Object.entries(mergedRecords)) {
          prevTooth[t] = { condition: rec.condition, updatedAt: now };
        }
        const childPatch = {
          ...latestChild,
          toothStates: prevTooth,
          updatedBy: username,
          updatedAt: now
        };
        await upsertChild(childPatch);
        await addToOutbox('UPSERT_CHILD', childId, childPatch);
      }

      if (navigator.onLine && token) {
        try {
          await performSync(token);
        } catch (syncError) {
          console.error('Sync failed, but visit saved locally:', syncError);
        }
      }

      notifySuccess(isEditMode ? 'Visit updated.' : 'Visit saved.');
      navigate(`/children/${childId}`, { state: { refreshVisits: true } });
    } catch (e) {
      setError(e.message || 'Failed to save visit');
      notifyError(e?.message || 'Failed to save visit');
    } finally {
      setSaving(false);
    }
  };

  if (visitLoadError) {
    return (
      <div className="container">
        <PageHeader
          title={isEditMode ? 'Edit Visit' : 'Visit Entry'}
          subtitle={child ? <PatientNameBlock child={child} /> : ''}
          icon="visit"
        />
        <div className="alert alert-danger" style={{ marginBottom: '12px' }}>
          {visitLoadError}
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => navigate(`/children/${childId}`)}>
          Back to profile
        </button>
        <NavBar />
      </div>
    );
  }

  if (!child || initializing) {
    return (
      <div className="container">
        <div className="loading">Loading...</div>
        <NavBar />
      </div>
    );
  }

  return (
    <div className="container" style={{ overflowX: 'hidden' }}>
      <PageHeader
        title={isEditMode ? 'Edit Visit' : 'Visit Entry'}
        subtitle={<PatientNameBlock child={child} />}
        icon="visit"
      />
      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card" style={{ marginBottom: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Date</label>
          <input className="form-control" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Chief complaint</h3>

        <div className="form-group">
          <label>Symptoms (tap to toggle; long-press to edit shortcuts; duration = days)</label>
          <EditableChipList
            storageKey="toothaid_presets_symptoms"
            defaultList={PRESET_SYMPTOMS}
            mode="toggle"
            activeMap={symptomActiveMap}
            onToggle={toggleSymptom}
          />

          {Object.keys(symptoms).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: 12 }}>
              {Object.entries(symptoms).map(([name, days]) => {
                const displayValue = days === '' ? '' : String(clampSymptomDays(days));
                return (
                  <div
                    key={name}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 120px',
                      gap: '10px',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ fontWeight: 650 }}>{name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>Days</label>
                      <input
                        type="number"
                        className="form-control"
                        min={1}
                        max={365}
                        value={displayValue}
                        onChange={(e) => {
                          const t = e.target.value;
                          if (t === '') {
                            setSymptoms((prev) => ({ ...prev, [name]: '' }));
                            return;
                          }
                          const n = Number(t);
                          if (!Number.isFinite(n)) return;
                          setSymptoms((prev) => ({ ...prev, [name]: Math.min(365, Math.max(1, Math.round(n))) }));
                        }}
                        onBlur={() => {
                          setSymptoms((prev) => {
                            if (prev[name] !== '') return prev;
                            return { ...prev, [name]: SYMPTOM_DAY_DEFAULT };
                          });
                        }}
                        style={{ minHeight: 44 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Chief complaint (free text)</label>
          <textarea
            className="form-control"
            value={chiefComplaint}
            onChange={(e) => setChiefComplaint(e.target.value)}
            rows={2}
            placeholder="Free text..."
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Examination</h3>
        <p style={{ fontSize: '13px', color: 'var(--color-muted)', marginTop: 0 }}>
          Select a tooth on the map, then choose a status. Tap another tooth to record more teeth.
        </p>

        <div className="form-group">
          <label>Tooth map</label>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setDentitionSafe('PERMANENT')}
                className={`chip-toggle${dentition === 'PERMANENT' ? ' chip-toggle--active' : ''}`}
                style={{ flex: 1 }}
              >
                Permanent
              </button>
              <button
                type="button"
                onClick={() => setDentitionSafe('PRIMARY')}
                className={`chip-toggle${dentition === 'PRIMARY' ? ' chip-toggle--active' : ''}`}
                style={{ flex: 1 }}
              >
                Primary
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px', overflowX: 'auto', paddingBottom: 2 }}>
            {toothGrid.map((row, idx) => (
              <div
                key={idx}
                style={{ display: 'grid', gridTemplateColumns: `repeat(${row.length}, minmax(44px, 1fr))`, gap: '6px' }}
              >
                {row.map((tooth) => renderExamToothButton(tooth))}
              </div>
            ))}
          </div>
        </div>

        {selectedExamTooth && (
          <>
            <div style={{ fontSize: '13px', fontWeight: 650, marginBottom: 8, color: '#374151' }}>
              Selected: tooth {selectedExamTooth}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              {CONDITIONS.map((c) => {
                const active = (toothRecords[selectedExamTooth]?.condition || 'sound') === c.id;
                const fg = isDarkHex(c.color) ? '#fff' : '#111827';
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setExamCondition(c.id)}
                    className={active ? 'chip-toggle chip-toggle--active' : 'chip-toggle'}
                    style={
                      active
                        ? {
                            background: c.color,
                            color: fg,
                            borderColor: c.color,
                            fontWeight: 650
                          }
                        : undefined
                    }
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div className="form-group">
              <label>Tooth note (optional)</label>
              <input
                type="text"
                className="form-control"
                value={toothRecords[selectedExamTooth]?.note || ''}
                onChange={(e) => setExamToothNote(e.target.value)}
                placeholder="Optional…"
              />
            </div>
          </>
        )}

        <div className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
          <label>Examination notes</label>
          <textarea
            className="form-control"
            value={examinationNotes}
            onChange={(e) => setExaminationNotes(e.target.value)}
            rows={2}
            placeholder="Notes for this examination section…"
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Treatment</h3>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>General treatment</div>
          <EditableChipList
            storageKey="toothaid_presets_general_treatment"
            defaultList={GENERAL_TREATMENTS}
            mode="toggle"
            activeMap={generalTreatmentActiveMap}
            onToggle={toggleGeneralTreatment}
          />
        </div>

        <div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Tooth-specific treatment</div>
          <p style={{ fontSize: '13px', color: 'var(--color-muted)', marginTop: 0 }}>
            Pick a treatment color below, then tap teeth on the map to assign it.
          </p>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: '13px', fontWeight: 650, display: 'block', marginBottom: 6 }}>
              Step 1 — Choose operation
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {COMMON_TREATMENTS.map((label) => {
                const color = TREATMENT_COLORS[label];
                const isActive = activeTreatment === label;
                const fg = isDarkHex(color) ? '#fff' : '#111827';
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setActiveTreatment((prev) => (prev === label ? null : label))}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '20px',
                      border: isActive ? `3px solid #111827` : '2px solid transparent',
                      background: color,
                      color: fg,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontSize: '14px',
                      boxShadow: isActive ? '0 0 0 2px #fff, 0 0 0 4px ' + color : 'none',
                      transition: 'box-shadow 0.15s, border 0.15s'
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!activeTreatment && (
              <p style={{ fontSize: '12px', color: 'var(--color-muted)', margin: '6px 0 0' }}>
                Select an operation above first, then tap teeth.
              </p>
            )}
            {activeTreatment && (
              <p style={{ fontSize: '12px', color: '#374151', margin: '6px 0 0', fontWeight: 600 }}>
                Active: <span style={{ color: TREATMENT_COLORS[activeTreatment] }}>{activeTreatment}</span> — tap teeth to assign or remove. Tap the pill again to deselect.
              </p>
            )}
          </div>

          <div className="form-group">
            <label style={{ fontSize: '13px', fontWeight: 650, display: 'block', marginBottom: 6 }}>
              Step 2 — Tap teeth
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: '10px',
                overflowX: 'auto',
                paddingBottom: 2,
                padding: activeTreatment === 'Cleaning' ? '8px' : '0',
                borderRadius: activeTreatment === 'Cleaning' ? '12px' : '0',
                background: activeTreatment === 'Cleaning' ? '#d1fae5' : 'transparent',
                border: activeTreatment === 'Cleaning' ? '2px dashed #10b981' : '2px dashed transparent',
                transition: 'background 0.2s, border 0.2s, padding 0.2s'
              }}
            >
              {toothGrid.map((row, idx) => (
                <div
                  key={`treat-row-${idx}`}
                  style={{ display: 'grid', gridTemplateColumns: `repeat(${row.length}, minmax(44px, 1fr))`, gap: '6px' }}
                >
                  {row.map((tooth) => renderTreatToothButton(tooth))}
                </div>
              ))}
            </div>
          </div>

          {Object.keys(toothTreatments).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: '13px', fontWeight: 650, display: 'block', marginBottom: 6 }}>
                Assigned treatments
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(toothTreatments)
                  .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
                  .map(([tooth, treatments]) => (
                    <div
                      key={tooth}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 10px',
                        borderRadius: '16px',
                        border: '1px solid #e5e7eb',
                        background: '#fff',
                        fontSize: '13px',
                        fontWeight: 650
                      }}
                      title={(treatments || []).join(', ') || 'selected'}
                    >
                      <span>{tooth}</span>
                      {(treatments || []).length > 0 && (
                        <span style={{ display: 'flex', gap: '2px' }}>
                          {(treatments || []).map((t, i) => (
                            <span
                              key={i}
                              style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: TREATMENT_COLORS[t] || '#999'
                              }}
                              title={t}
                            />
                          ))}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeTreatTooth(tooth)}
                        style={{
                          marginLeft: '2px',
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: '14px',
                          lineHeight: 1,
                          color: '#9ca3af',
                          fontWeight: 700
                        }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Medication</h3>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '13px', color: 'var(--color-muted)', marginBottom: 6 }}>
            Quick names (tap to fill form; long-press to edit shortcuts)
          </div>
          <EditableChipList
            storageKey="toothaid_presets_medications"
            defaultList={COMMON_MEDS}
            mode="apply"
            onApply={applyQuickMed}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Medication name</label>
            <input
              type="text"
              className="form-control"
              value={medDraft.name}
              onChange={(e) => setMedDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Tap a quick option above or type a name…"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Dosage</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="text"
                  className="form-control"
                  value={medDraft.dosage}
                  onChange={(e) => setMedDraft((d) => ({ ...d, dosage: e.target.value }))}
                  placeholder="e.g. 250"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <span style={{ color: 'var(--color-muted)', fontWeight: 700 }}>mg</span>
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Times per day</label>
              <input
                type="text"
                className="form-control"
                value={medDraft.frequencyPerDay}
                onChange={(e) => setMedDraft((d) => ({ ...d, frequencyPerDay: e.target.value }))}
                placeholder="e.g. 2"
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Days</label>
              <input
                type="text"
                className="form-control"
                value={medDraft.days}
                onChange={(e) => setMedDraft((d) => ({ ...d, days: e.target.value }))}
                placeholder="e.g. 7"
              />
            </div>
          </div>
          <button type="button" className="btn btn-sm" style={{ ...btnAddGreen, width: '100%' }} onClick={addMedicationFromDraft}>
            Add medication
          </button>
        </div>

        {medications.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {medications.map((m, idx) => (
              <div key={idx} style={{ padding: '8px 12px', border: '1px solid #e5e5ea', borderRadius: 'var(--radius-card)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                  <div>
                    <div style={{ fontWeight: 750 }}>{m.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '2px' }}>
                      {m.dosage ? `Dosage: ${m.dosage}` : 'Dosage: —'} ·{' '}
                      {m.frequencyPerDay ? `Times/day: ${m.frequencyPerDay}` : 'Times/day: —'} ·{' '}
                      {m.days ? `Days: ${m.days}` : 'Days: —'}
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeMedicationAt(idx)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Notes</h3>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Visit notes (optional)</label>
          <textarea
            className="form-control"
            value={visitNotes}
            onChange={(e) => setVisitNotes(e.target.value)}
            rows={3}
            placeholder="General notes for this visit…"
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Behavior Scale</h3>
        <p style={{ fontSize: '13px', color: 'var(--color-muted)', margin: '0 0 12px', lineHeight: 1.45 }}>
          Record the patient&apos;s behavior for this visit.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setBehaviourFrankl((prev) => (String(prev) === String(n) ? '' : String(n)))}
              style={{
                flex: '1 1 64px',
                padding: '10px 8px',
                borderRadius: 10,
                border: String(behaviourFrankl) === String(n) ? '2px solid #2563eb' : '1px solid #e5e7eb',
                background: String(behaviourFrankl) === String(n) ? '#eff6ff' : '#fff',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              F{n}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flex: '1 1 80px' }}
            onClick={() => setBehaviourFrankl('')}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '12px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '10px' }}>Follow-up appointment</h3>
        <p style={{ fontSize: '13px', color: 'var(--color-muted)', margin: '0 0 12px', lineHeight: 1.45 }}>
          Flag when this patient still needs a return visit booked. Choose how soon they should be scheduled — this
          controls order on Home → Schedule follow-ups.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginBottom: '12px' }}>
          <input
            type="checkbox"
            checked={requiresFollowUp}
            onChange={(e) => {
              const on = e.target.checked;
              setRequiresFollowUp(on);
              if (!on) {
                setFollowUpPriority(FOLLOW_UP_WITHIN_7_DAYS);
                setFollowUpCustomDays('14');
              }
            }}
          />
          <span style={{ fontWeight: 650 }}>Requires follow-up appointment</span>
        </label>
        {requiresFollowUp && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Follow-up timing</label>
            <select
              value={normalizeFollowUpTiming(followUpPriority)}
              onChange={(e) => setFollowUpPriority(e.target.value)}
              className="form-control"
            >
              {FOLLOW_UP_FORM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {normalizeFollowUpTiming(followUpPriority) === FOLLOW_UP_CUSTOM_DAYS && (
              <div style={{ marginTop: '10px' }}>
                <label htmlFor="follow-up-custom-days">Number of days</label>
                <input
                  id="follow-up-custom-days"
                  type="number"
                  min="1"
                  max="365"
                  value={followUpCustomDays}
                  onChange={(e) => setFollowUpCustomDays(e.target.value)}
                  className="form-control"
                  style={{ marginTop: '6px' }}
                />
              </div>
            )}
            <p style={{ fontSize: '12px', color: 'var(--color-muted)', margin: '8px 0 0' }}>
              After save, use Schedule follow-up on Home to book the next slot.
            </p>
          </div>
        )}
      </div>

      <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={submit}>
        {saving ? 'Saving...' : isEditMode ? 'Save changes' : 'Save Visit'}
      </button>

      <NavBar />
    </div>
  );
}
