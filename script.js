/* =========================================================
   STATIC GOOGLE SHEETS DATA SERVICE
   Seluruh data dibaca langsung dari endpoint Google
   Visualization (gviz) milik spreadsheet publik.
   ========================================================= */
const GakuseiDataService = (() => {
  const CONFIG = {
    CACHE_TTL_MS: 30000,
    TIME_ZONE: 'Asia/Pontianak',

    MASTER_SPREADSHEET_ID: '1pubsttW1izchGCBHWVwFZwogUFmVHAjUe2kURHJGNU0',
    MASTER_SHEET: 'PENDATAAN GAKUSEI',
    LEAVE_SHEET: 'CUTI',
    JOB_SHEET: 'PEKERJAAN GAKUSEI & CITIZEN',

    FINANCE_SPREADSHEET_ID: '1RpC0wRpZCSpQUWKUxau8j1VxbpwGfCq-nxt6a8Oj9JY',
    FINANCE_SHEET: 'MASTER SALDO',

    POINT_SPREADSHEET_ID: '10rtaoj1zwRTmFiNiEVnxOQ1Uswrqqj6jhMN0Hpq9Lqg',
    POINT_RECAP_SHEET: 'REKAP POIN',
    POINT_LOG_SHEET: 'LOG POINT',

    ACADEMIC_SPREADSHEET_ID: '1LXbCIYV5RGjEKarl_1T7NgliKfyAiC_IDZ7TRItI15E',

    /*
     * GViz tidak menyediakan daftar nama tab. Karena nama semester memakai
     * nomor + format A.R., website memeriksa nomor secara berurutan dan hanya
     * menerima respons yang benar-benar memiliki struktur Academic Record.
     * Saat semester baru dibuat, nomor berikutnya akan ditemukan otomatis.
     */
    ACADEMIC_SHEET_NAMES: [],
    ACADEMIC_PROBE_START: 1,
    ACADEMIC_PROBE_MAX: 200,
    ACADEMIC_MAX_EMPTY_BEFORE_FIRST: 80,
    ACADEMIC_STOP_AFTER_MISSES: 12,
    ACADEMIC_DISCOVERY_REFRESH_MS: 60000,
    ACADEMIC_DISCOVERY_STORAGE_TTL_MS: 21600000,

    GENERATION_BASE_YEAR: 2024,
    HEADER_LOGO_ID: '1cdbjaAkcEI3KodOgpCNbtEL-K5VQm7pK',
    HEADMASTER_STAMP_ID: '15hyCi6QvnTsRemJiwtQgtajfmPZPYmG-',
    STUDENT_AFFAIRS_STAMP_ID: '1GSe_tfPQzd1ph4XfXRY_o0jJRORl_Yn6',

    DORMS: {
      KSI: {
        code: 'KSI',
        name: 'KŌSEI',
        theme: 'kosei',
        logoId: '1Bh3uBwVn1SQ21p-_NDWQsTQ0RmcdTUN7'
      },
      TSY: {
        code: 'TSY',
        name: 'TSUKIYOMI',
        theme: 'tsukiyomi',
        logoId: '1FTX4-ufdkV_JIBq1s4URaM435poh_r-_'
      },
      YMY: {
        code: 'YMY',
        name: 'YAMIYO',
        theme: 'yamiyo',
        logoId: '1Pp83Yuci96A5W_TpKA_avwcLekUgDwmS'
      }
    }
  };

  const tableCache = new Map();
  let academicSheetPromise = null;
  let academicSheetPromiseAt = 0;
  let lastStudentCache = null;

  async function getStudentData(inputId) {
    try {
      const master = await getMasterStudentById(inputId);
      const dorm = getDormById(master.studentId, master.dormName);
      const xProfile = buildXProfile(master.usernameValue);

      const [status, occupations, financeBalance, studentPoint, academicRecords] =
        await Promise.all([
          safeResult(() => getLeaveStatus(master.studentId), {
            code: 'ACTIVE', label: 'ACTIVE', theme: 'active'
          }),
          safeResult(() => getOccupationsById(master.studentId), []),
          safeResult(() => getFinanceBalanceById(master.studentId), '-'),
          safeResult(() => getStudentPointData(master.studentId), emptyPointData()),
          safeResult(() => getAcademicRecordData(master.studentId, dorm.code), {
            available: false,
            records: [],
            detectedSemesterSheets: 0,
            timelineSemesterSheets: 0,
            matchedSemesterSheets: 0,
            missingSemesterSheets: [],
            scanErrors: [],
            message: 'Academic record tidak dapat dimuat.'
          })
        ]);

      const response = {
        success: true,
        data: {
          namaLatin: master.namaLatin || '-',
          namaKanji: master.namaKanji || '-',
          nomorId: master.studentId,
          usernameX: xProfile.username || '-',
          usernameXLink: xProfile.url || '',
          tingkatKelas: master.currentGrade || '-',
          rank: master.currentRank || '-',
          asrama: dorm,
          tanggalLahir: master.birthDate || '-',
          status,
          daftarPekerjaan: occupations,
          jumlahPekerjaan: occupations.length,
          financeBalance,
          studentPoint,
          academicRecords,
          idCard: buildMediaInfo(master.idCardValue, 'w1600'),
          foto: buildMediaInfo(master.photoValue, 'w1200'),
          generatedAt: Date.now()
        }
      };

      lastStudentCache = {
        id: master.studentId,
        master,
        dorm,
        academicRecords
      };

      return response;
    } catch (error) {
      return {
        success: false,
        message: error && error.message
          ? error.message
          : 'Terjadi kesalahan saat membaca data siswa.'
      };
    }
  }

  async function getAcademicPdfPayload(inputId, semesterSheetName, mode) {
    const studentId = normalizeId(inputId);
    let master;
    let dorm;
    let academicData;

    if (lastStudentCache && lastStudentCache.id === studentId) {
      master = lastStudentCache.master;
      dorm = lastStudentCache.dorm;
      academicData = lastStudentCache.academicRecords;
    } else {
      master = await getMasterStudentById(studentId);
      dorm = getDormById(master.studentId, master.dormName);
      academicData = await getAcademicRecordData(master.studentId, dorm.code);
    }

    const available = (academicData.records || [])
      .filter(record => record && record.sourceAvailable !== false)
      .slice()
      .sort(sortAcademicOldest);

    if (!available.length) {
      throw new Error('Data rapor siswa tidak ditemukan pada seluruh sheet A.R.');
    }

    const normalizedMode = String(mode || 'semester').toLowerCase();
    let records;

    if (normalizedMode === 'ledger') {
      records = available;
    } else {
      records = available.filter(record =>
        record.sheetName === String(semesterSheetName || '').trim()
      );
      if (!records.length) {
        throw new Error('Data nilai siswa tidak ditemukan pada semester tersebut.');
      }
    }

    const fileName = normalizedMode === 'ledger'
      ? `MAHOUTOKORO_ACADEMIC_LEDGER_${master.studentId}.pdf`
      : `MAHOUTOKORO_TEMPORARY_RECORD_${master.studentId}_${records[0].sheetName}.pdf`;

    return {
      success: true,
      mode: normalizedMode,
      fileName: sanitizeFileName(fileName),
      student: {
        namaLatin: master.namaLatin,
        namaKanji: master.namaKanji,
        nomorId: master.studentId,
        tingkatKelas: master.currentGrade,
        tanggalLahir: master.birthDate,
        generation: deriveGenerationLabel(master.studentId),
        asrama: dorm
      },
      records,
      matchedRecordCount: available.length,
      totalTimelineCount: available.length,
      generatedDateLatin: formatDateLong(new Date()),
      assets: {
        headerLogo: makeDriveImageUrl(CONFIG.HEADER_LOGO_ID, 'w1000'),
        dormLogo: dorm.code && CONFIG.DORMS[dorm.code]
          ? makeDriveImageUrl(CONFIG.DORMS[dorm.code].logoId, 'w1000')
          : '',
        photo: buildMediaInfo(master.photoValue, 'w1600').previewUrl,
        headmasterStamp: makeDriveImageUrl(CONFIG.HEADMASTER_STAMP_ID, 'w1000'),
        studentAffairsStamp: makeDriveImageUrl(CONFIG.STUDENT_AFFAIRS_STAMP_ID, 'w1000')
      }
    };
  }

  async function getLatestPromotionRecap() {
    try {
      const sheets = await discoverAcademicSheets(true);
      if (!sheets.length) {
        throw new Error('Tidak ada sheet A.R. yang ditemukan melalui gviz.');
      }

      const latestSheet = sheets[sheets.length - 1];
      const [{ display }, masterMap] = await Promise.all([
        fetchTable({
          spreadsheetId: CONFIG.ACADEMIC_SPREADSHEET_ID,
          sheet: latestSheet,
          range: 'A:AJ'
        }),
        getMasterStudentMap()
      ]);

      const rows = [];
      const seen = new Set();
      const nenseiByRow = buildNenseiByRow(display);

      display.forEach((row, index) => {
        const studentId = normalizeId(row[5]);
        if (!studentId || !isLikelyStudentId(studentId) || seen.has(studentId)) return;
        seen.add(studentId);

        const master = masterMap[studentId] || {};
        const dorm = getDormById(studentId, master.dormName || '');
        rows.push({
          nomorId: studentId,
          namaLatin: master.namaLatin || '-',
          namaKanji: master.namaKanji || '-',
          asrama: dorm.name,
          dormCode: dorm.code || '',
          nenseiLabel: nenseiByRow[index]
            ? `${nenseiByRow[index]} NENSEI`
            : 'NENSEI NOT DETECTED',
          gradeStatus: cleanAcademicText(row[33]),
          rankingResult: cleanAcademicText(row[34]),
          remarks: cleanAcademicText(row[35])
        });
      });

      const dormOrder = { KSI: 1, TSY: 2, YMY: 3 };
      rows.sort((a, b) =>
        ((dormOrder[a.dormCode] || 99) - (dormOrder[b.dormCode] || 99)) ||
        a.nomorId.localeCompare(b.nomorId)
      );

      const summary = {
        total: rows.length,
        promoted: rows.filter(row => /PROMOTED/i.test(row.gradeStatus)).length,
        retained: rows.filter(row => /RETAINED/i.test(row.gradeStatus)).length,
        unspecified: 0
      };
      summary.unspecified = summary.total - summary.promoted - summary.retained;

      return {
        success: true,
        semesterTitle: latestSheet,
        generatedAt: formatDateTime(new Date()),
        summary,
        rows
      };
    } catch (error) {
      return {
        success: false,
        message: `Rekap promotion tidak dapat dimuat: ${error.message || error}`
      };
    }
  }

  async function getMasterStudentById(inputId) {
    const requestedId = normalizeId(inputId);
    if (!requestedId) throw new Error('Masukkan nomor ID Gakusei terlebih dahulu.');

    const table = await fetchTable({
      spreadsheetId: CONFIG.MASTER_SPREADSHEET_ID,
      sheet: CONFIG.MASTER_SHEET,
      range: 'C2:N'
    });

    const foundIndex = table.display.findIndex(row => idsMatch(row[2], requestedId));
    if (foundIndex < 0) throw new Error('Nomor ID Gakusei tidak ditemukan.');

    const displayRow = table.display[foundIndex] || [];
    const rawRow = table.raw[foundIndex] || [];

    return {
      studentId: normalizeId(displayRow[2]),
      namaLatin: displayRow[0] || '-',
      namaKanji: displayRow[1] || '-',
      usernameValue: chooseCellValue(displayRow[3], rawRow[3]),
      currentGrade: displayRow[4] || '-',
      currentRank: displayRow[5] || '-',
      dormName: displayRow[6] || '',
      birthDate: displayRow[7] || '-',
      idCardValue: chooseCellValue(displayRow[10], rawRow[10]),
      photoValue: chooseCellValue(displayRow[11], rawRow[11])
    };
  }

  async function getMasterStudentMap() {
    const table = await fetchTable({
      spreadsheetId: CONFIG.MASTER_SPREADSHEET_ID,
      sheet: CONFIG.MASTER_SHEET,
      range: 'C2:I'
    });
    const map = {};
    table.display.forEach(row => {
      const id = normalizeId(row[2]);
      if (!id) return;
      map[id] = {
        namaLatin: row[0] || '-',
        namaKanji: row[1] || '-',
        currentGrade: row[4] || '-',
        currentRank: row[5] || '-',
        dormName: row[6] || ''
      };
    });
    return map;
  }

  function getDormById(id, fallbackDormName) {
    const normalized = normalizeId(id);
    const code = ['KSI', 'TSY', 'YMY'].find(item => normalized.includes(item)) || '';
    if (code && CONFIG.DORMS[code]) {
      const dorm = CONFIG.DORMS[code];
      return {
        code: dorm.code,
        name: dorm.name,
        theme: dorm.theme,
        logoUrl: makeDriveImageUrl(dorm.logoId, 'w700'),
        logoUrls: makeDriveImageUrls(dorm.logoId, 'w700'),
        logoOpenUrl: makeDriveViewUrl(dorm.logoId),
        recognized: true
      };
    }
    return {
      code: '',
      name: String(fallbackDormName || 'UNASSIGNED').trim() || 'UNASSIGNED',
      theme: 'unknown',
      logoUrl: '',
      logoUrls: [],
      logoOpenUrl: '',
      recognized: false
    };
  }

  async function getLeaveStatus(id) {
    /*
     * Sheet CUTI:
     * - Kolom D = nomor ID Gakusei (kunci pencarian)
     * - Kolom K = penanda bahwa masa cuti sudah selesai
     *
     * Baris terakhir untuk ID yang sama dipakai agar riwayat cuti lama
     * yang sudah selesai tidak menimpa pengajuan cuti yang lebih baru.
     */
    const table = await fetchTable({
      spreadsheetId: CONFIG.MASTER_SPREADSHEET_ID,
      sheet: CONFIG.LEAVE_SHEET,
      range: 'D2:K'
    });

    const matchingRows = table.display.filter(row => idsMatch(row[0], id));

    // Tidak pernah tercatat di sheet CUTI = masih aktif.
    if (!matchingRows.length) {
      return { code: 'ACTIVE', label: 'ACTIVE', theme: 'active' };
    }

    const latestLeaveRow = matchingRows[matchingRows.length - 1];
    const leaveFinishedValue = String(latestLeaveRow[7] ?? '').trim(); // K

    // Kolom K terisi = cuti selesai, status kembali ACTIVE.
    if (leaveFinishedValue !== '') {
      return { code: 'ACTIVE', label: 'ACTIVE', theme: 'active' };
    }

    return { code: 'ON_LEAVE', label: 'ON LEAVE', theme: 'leave' };
  }

  async function getOccupationsById(id) {
    const table = await fetchTable({
      spreadsheetId: CONFIG.MASTER_SPREADSHEET_ID,
      sheet: CONFIG.JOB_SHEET,
      range: 'B9:G'
    });

    let currentWorkplace = '';
    const result = [];
    const seen = new Set();

    table.display.forEach(row => {
      const rowId = String(row[2] || '').trim();
      const position = String(row[4] || '').trim();
      const section = getJobSectionTitle(row);

      if (section) {
        currentWorkplace = section.replace(/\s+/g, ' ').trim();
        return;
      }

      if (!rowId || !idsMatch(rowId, id) || !position) return;
      const workplace = currentWorkplace || 'UNSPECIFIED WORKPLACE';
      const key = `${workplace}|${position}`.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ workplace, position });
    });

    return result;
  }

  function getJobSectionTitle(row) {
    const values = (row || []).map(value => String(value || '').trim());
    const rowId = values[2] || '';
    if (rowId && isLikelyStudentId(rowId)) return '';

    const nonEmpty = values.filter(Boolean);
    const firstText = nonEmpty[0] || '';
    if (!firstText || isGenericJobHeading(firstText)) return '';

    const upperTitle = firstText === firstText.toUpperCase() &&
      firstText.length >= 3 && !/\d{3,}/.test(firstText);

    return (!rowId && (nonEmpty.length <= 2 || upperTitle)) ? firstText : '';
  }

  function isGenericJobHeading(value) {
    const text = String(value || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
    if (!text) return true;
    return [
      'NO', 'NAMA', 'NO. ID', 'NO ID', 'NOMOR ID',
      'USERNAME', 'POSISI', 'MASA JABATAN'
    ].includes(text) || text.includes('TABEL JABATAN');
  }

  async function getFinanceBalanceById(id) {
    const table = await fetchTable({
      spreadsheetId: CONFIG.FINANCE_SPREADSHEET_ID,
      sheet: CONFIG.FINANCE_SHEET,
      range: 'D2:F'
    });
    const found = table.display.find(row => idsMatch(row[0], id));
    return found && found[2] ? found[2] : '-';
  }

  function emptyPointData() {
    return {
      available: false,
      semesterTitle: 'CURRENT SEMESTER',
      totals: { gp: '0', rp: '0', fhp: '0' },
      logs: [],
      message: 'Student Point Log tidak dapat dimuat.',
      spreadsheetUpdatedAt: ''
    };
  }

  async function getStudentPointData(id) {
    const result = emptyPointData();
    const [semesterTable, recapTable, logTable] = await Promise.all([
      fetchTable({
        spreadsheetId: CONFIG.POINT_SPREADSHEET_ID,
        sheet: CONFIG.POINT_RECAP_SHEET,
        range: 'A9:Z9'
      }),
      fetchTable({
        spreadsheetId: CONFIG.POINT_SPREADSHEET_ID,
        sheet: CONFIG.POINT_RECAP_SHEET,
        range: 'F:L'
      }),
      fetchTable({
        spreadsheetId: CONFIG.POINT_SPREADSHEET_ID,
        sheet: CONFIG.POINT_LOG_SHEET,
        range: 'C:I'
      })
    ]);

    const semesterTitle = (semesterTable.display[0] || []).find(value =>
      String(value || '').trim()
    ) || 'CURRENT SEMESTER';

    const totals = { gp: '0', rp: '0', fhp: '0' };
    for (let index = recapTable.display.length - 1; index >= 0; index--) {
      const row = recapTable.display[index];
      if (!idsMatch(row[0], id)) continue;
      totals.gp = normalizeDisplayPoint(row[4]);
      totals.rp = normalizeDisplayPoint(row[5]);
      totals.fhp = normalizeDisplayPoint(row[6]);
      break;
    }

    const semesterPeriod = extractDateRangeFromText(semesterTitle);
    const logs = [];
    let newestTimestamp = null;

    logTable.display.forEach((displayRow, index) => {
      if (!idsMatch(displayRow[0], id)) return;
      const rawRow = logTable.raw[index] || [];
      const timestamp = coerceDate(rawRow[6]) || coerceDate(displayRow[6]);

      if (semesterPeriod && timestamp &&
          (timestamp < semesterPeriod.start || timestamp > semesterPeriod.end)) {
        return;
      }

      if (timestamp && (!newestTimestamp || timestamp > newestTimestamp)) {
        newestTimestamp = timestamp;
      }

      logs.push({
        date: timestamp ? formatDateTime(timestamp) : (displayRow[6] || '-'),
        timestamp: timestamp ? timestamp.getTime() : 0,
        description: String(displayRow[1] || '').trim() || '-',
        gp: buildPointDisplay(displayRow[3], 'GP'),
        rp: buildPointDisplay(displayRow[4], 'RP'),
        fhp: buildPointDisplay(displayRow[5], 'FHP')
      });
    });

    logs.sort((a, b) => b.timestamp - a.timestamp);

    return {
      available: true,
      semesterTitle,
      totals,
      logs,
      message: logs.length
        ? ''
        : 'No point log was found for this student in the current semester.',
      spreadsheetUpdatedAt: newestTimestamp ? formatDateTime(newestTimestamp) : ''
    };
  }

  function buildPointDisplay(value, code) {
    const text = String(value == null ? '' : value).trim();
    const numeric = parseFlexibleNumber(text);
    const hasValue = text !== '' && numeric !== null && numeric !== 0;
    if (!hasValue) return { hasValue: false, value: 0, text: '' };
    return {
      hasValue: true,
      value: numeric,
      text: `${numeric > 0 ? '+' : ''}${formatPlainNumber(numeric)}${code}`
    };
  }

  function normalizeDisplayPoint(value) {
    const numeric = parseFlexibleNumber(value);
    return numeric === null ? '0' : formatPlainNumber(numeric);
  }

  async function getAcademicRecordData(studentId, dormCode) {
    const sheets = await discoverAcademicSheets();
    const scanErrors = [];

    const records = (await mapLimit(sheets, 5, async sheetName => {
      try {
        return await readAcademicSemesterRecord(sheetName, studentId, dormCode);
      } catch (error) {
        scanErrors.push({ sheetName, message: error.message || String(error) });
        return null;
      }
    })).filter(Boolean).sort(sortAcademicNewest);

    return {
      available: records.length > 0,
      records,
      detectedSemesterSheets: sheets.length,
      timelineSemesterSheets: records.length,
      matchedSemesterSheets: records.length,
      missingSemesterSheets: [],
      scanErrors,
      firstSemesterTitle: records.length ? records[records.length - 1].sheetName : '',
      latestSemesterTitle: sheets.length ? sheets[sheets.length - 1] : '',
      message: records.length
        ? ''
        : sheets.length
          ? 'Nomor ID siswa tidak ditemukan di kolom F pada seluruh sheet A.R. yang terdeteksi.'
          : 'Tidak ada sheet semester berformat A.R. yang terdeteksi.'
    };
  }

  async function readAcademicSemesterRecord(sheetName, studentId, dormCode) {
    /*
     * Jangan mencari ID lewat F:F lalu menebak nomor baris untuk request kedua.
     * Pada respons GViz, range satu kolom dapat memangkas baris kosong sehingga
     * index F:F tidak selalu sama dengan index A:AJ. Akibatnya ID ditemukan,
     * tetapi nilai dibaca dari baris lain atau baris kosong.
     *
     * Seluruh kolom A:AJ dibaca sekali, lalu pencarian ID dan pengambilan nilai
     * dilakukan pada matriks yang sama agar index baris selalu konsisten.
     */
    const table = await fetchTable({
      spreadsheetId: CONFIG.ACADEMIC_SPREADSHEET_ID,
      sheet: sheetName,
      range: 'A:AJ'
    });

    const display = (table.display || []).map(row => padRow(row, 36));
    const raw = (table.raw || []).map(row => padRow(row, 36));

    const candidates = [];

    display.forEach((row, index) => {
      const rawId = raw[index] ? raw[index][5] : '';

      if (
        idsMatch(row[5], studentId) ||
        idsMatch(rawId, studentId)
      ) {
        const score = row
          .slice(9, 36)
          .filter(value => String(value == null ? '' : value).trim() !== '')
          .length;

        candidates.push({
          index,
          score
        });
      }
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) =>
      (b.score - a.score) ||
      (b.index - a.index)
    );

    const selectedIndex = candidates[0].index;
    const displayRow = display[selectedIndex];
    const rawRow = raw[selectedIndex];
    const nensei = findNenseiForStudentRow(display, selectedIndex);
    const subjects = getAcademicSubjects(
      nensei,
      dormCode,
      displayRow,
      display,
      selectedIndex
    );
    const semesterNumber = extractSemesterNumber(sheetName);

    return {
      sourceAvailable: true,
      sourceMessage: '',
      sheetName,
      semesterTitle: sheetName,
      semesterNumber,
      semesterSortKey: semesterNumber >= 0 ? semesterNumber : 100000,
      sheetIndex: semesterNumber >= 0 ? semesterNumber : 100000,
      nensei,
      nenseiLabel: nensei ? `${nensei} NENSEI` : 'NENSEI NOT DETECTED',
      participation: {
        quidditch: buildParticipation(rawRow, displayRow, 10, false),
        combat: buildParticipation(rawRow, displayRow, 11, nensei === 1),
        quest: buildParticipation(rawRow, displayRow, 12, false),
        shiken: buildParticipation(rawRow, displayRow, 13, false)
      },
      subjects,
      totalGp: cleanAcademicMark(displayRow[7]),
      totalFhp: cleanAcademicMark(displayRow[8]),
      gradeStatus: cleanAcademicText(displayRow[33]),
      rankingResult: cleanAcademicText(displayRow[34]),
      remarks: cleanAcademicText(displayRow[35]),
      averageNumberMark: calculateAcademicAverage(subjects),
      sourceRow: selectedIndex + 1
    };
  }

  async function discoverAcademicSheets(forceRefresh = false) {
    const now = Date.now();

    if (
      !forceRefresh &&
      academicSheetPromise &&
      now - academicSheetPromiseAt < CONFIG.ACADEMIC_DISCOVERY_REFRESH_MS
    ) {
      return academicSheetPromise;
    }

    academicSheetPromiseAt = now;

    academicSheetPromise = (async () => {
      /*
       * Gunakan key versi baru agar cache lama yang pernah memasukkan
       * sheet palsu seperti "40 A.R." tidak dipakai kembali.
       */
      const storageKey =
        `mahoutokoro-ar-sheets-v4-${CONFIG.ACADEMIC_SPREADSHEET_ID}`;

      const configured = CONFIG.ACADEMIC_SHEET_NAMES
        .map(name => String(name || '').trim())
        .filter(Boolean);

      const invalidFingerprint = await getInvalidAcademicProbeFingerprint();
      const acceptedFingerprints = new Set();
      const valid = [];

      let storedNames = [];

      if (configured.length) {
        storedNames = configured.slice();
      } else {
        try {
          const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
          if (
            stored &&
            Array.isArray(stored.names) &&
            now - Number(stored.savedAt || 0) <
              CONFIG.ACADEMIC_DISCOVERY_STORAGE_TTL_MS
          ) {
            storedNames = stored.names;
          }
        } catch (error) {}
      }

      /*
       * Nama yang tersimpan tetap divalidasi ulang. Jadi sheet yang sudah
       * dihapus atau cache yang keliru tidak akan ikut ditampilkan.
       */
      for (const sheetName of storedNames.sort(compareAcademicSheetNames)) {
        const probe = await probeAcademicSheet(
          sheetName,
          invalidFingerprint,
          acceptedFingerprints
        );

        if (!probe) continue;

        valid.push(probe.name);
        acceptedFingerprints.add(probe.fingerprint);
      }

      let startNumber = CONFIG.ACADEMIC_PROBE_START;

      if (valid.length) {
        const latestNumber = Math.max(
          ...valid.map(extractSemesterNumber).filter(number => number >= 0)
        );

        if (Number.isFinite(latestNumber)) {
          startNumber = Math.max(CONFIG.ACADEMIC_PROBE_START, latestNumber + 1);
        }
      }

      let foundAny = valid.length > 0;
      let consecutiveMisses = 0;

      for (
        let number = startNumber;
        number <= CONFIG.ACADEMIC_PROBE_MAX;
        number++
      ) {
        let found = null;

        for (const candidate of buildAcademicSheetNameCandidates(number)) {
          const probe = await probeAcademicSheet(
            candidate,
            invalidFingerprint,
            acceptedFingerprints
          );

          if (probe) {
            found = probe;
            break;
          }
        }

        if (found) {
          valid.push(found.name);
          acceptedFingerprints.add(found.fingerprint);
          foundAny = true;
          consecutiveMisses = 0;
        } else {
          consecutiveMisses++;
        }

        /*
         * Setelah sheet terakhir ditemukan, cukup periksa beberapa nomor
         * berikutnya. Ketika semester baru ditambahkan, pemeriksaan berikutnya
         * akan melanjutkan dari nomor terakhir yang tersimpan.
         */
        if (
          foundAny &&
          consecutiveMisses >= CONFIG.ACADEMIC_STOP_AFTER_MISSES
        ) {
          break;
        }

        if (
          !foundAny &&
          number >= CONFIG.ACADEMIC_MAX_EMPTY_BEFORE_FIRST
        ) {
          break;
        }
      }

      const output = Array.from(new Set(valid)).sort(compareAcademicSheetNames);

      if (!configured.length) {
        try {
          localStorage.setItem(storageKey, JSON.stringify({
            names: output,
            savedAt: Date.now()
          }));
        } catch (error) {}
      }

      return output;
    })();

    return academicSheetPromise;
  }

  function buildAcademicSheetNameCandidates(number) {
    const roman = numberToRoman(number);

    return Array.from(new Set([
      `${number} A.R.`,
      `A.R. ${number}`,
      `${number} AR`,
      `PERIODE ${number} A.R.`,
      roman ? `PERIODE ${roman} A.R.` : ''
    ].filter(Boolean)));
  }

  async function getInvalidAcademicProbeFingerprint() {
    try {
      const table = await fetchTable({
        spreadsheetId: CONFIG.ACADEMIC_SPREADSHEET_ID,
        sheet: '__MAHOUTOKORO_AR_SHEET_MUST_NOT_EXIST__',
        range: 'A1:AJ160',
        bypassCache: true
      });

      return isAcademicSheetTable(table)
        ? buildAcademicTableFingerprint(table)
        : '';
    } catch (error) {
      return '';
    }
  }

  async function probeAcademicSheet(
    sheetName,
    invalidFingerprint = '',
    acceptedFingerprints = new Set()
  ) {
    try {
      const table = await fetchTable({
        spreadsheetId: CONFIG.ACADEMIC_SPREADSHEET_ID,
        sheet: sheetName,
        range: 'A1:AJ160',
        bypassCache: true
      });

      if (!isAcademicSheetTable(table)) return null;

      const fingerprint = buildAcademicTableFingerprint(table);

      /*
       * Beberapa respons GViz dapat jatuh kembali ke tab pertama ketika nama
       * sheet tidak valid. Sidik data kontrol dan duplikat ditolak agar nomor
       * yang belum memiliki sheet tidak dianggap sebagai semester nyata.
       */
      if (!fingerprint) return null;
      if (invalidFingerprint && fingerprint === invalidFingerprint) return null;
      if (acceptedFingerprints.has(fingerprint)) return null;

      return {
        name: sheetName,
        fingerprint
      };
    } catch (error) {
      return null;
    }
  }

  function isAcademicSheetTable(table) {
    const rows = Array.isArray(table && table.display)
      ? table.display.map(row => padRow(row, 36))
      : [];

    if (!rows.length) return false;

    const headerText = rows
      .slice(0, 160)
      .map(row => row.join(' '))
      .join(' ')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/\s+/g, ' ');

    const hasAcademicHeader = [
      'NENSEI',
      'HISTORY OF JAPANESE MAGIC',
      'MAGIC OF THE FIVE GREAT ELEMENTS',
      'ART OF INCANTATIONS',
      'QUIDDITCH',
      'SHIKEN',
      'GRADE STATUS',
      'RANKING'
    ].some(marker => headerText.includes(marker));

    const hasStudentId = rows.some(row => isLikelyStudentId(row[5]));

    /*
     * Template semester yang belum berisi siswa tetap diterima selama header
     * akademiknya ada. Sheet biasa tanpa struktur A.R. ditolak.
     */
    return hasAcademicHeader || (
      hasStudentId &&
      /(?:NAK|KANJI|NUMBER MARK|TOTAL GP|TOTAL FHP)/.test(headerText)
    );
  }

  function buildAcademicTableFingerprint(table) {
    if (table && table.gvizSig) {
      return `sig:${table.gvizSig}`;
    }

    const source = JSON.stringify(
      (table && Array.isArray(table.display) ? table.display : [])
        .slice(0, 160)
        .map(row => padRow(row, 36).map(value => String(value || '').trim()))
    );

    let hash = 2166136261;

    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return `fnv:${(hash >>> 0).toString(16)}`;
  }

  function compareAcademicSheetNames(a, b) {
    const an = extractSemesterNumber(a);
    const bn = extractSemesterNumber(b);
    return (an >= 0 ? an : 100000) - (bn >= 0 ? bn : 100000) ||
      String(a).localeCompare(String(b));
  }

  function sortAcademicOldest(a, b) {
    return (a.semesterSortKey - b.semesterSortKey) ||
      ((a.sheetIndex || 0) - (b.sheetIndex || 0));
  }

  function sortAcademicNewest(a, b) {
    return sortAcademicOldest(b, a);
  }

  function findNenseiForStudentRow(display, studentRowIndex) {
    const firstRow = Math.max(0, studentRowIndex - 80);
    for (let rowIndex = studentRowIndex; rowIndex >= firstRow; rowIndex--) {
      const rowText = (display[rowIndex] || [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
      const level = extractNenseiFromText(rowText);
      if (level) return level;
    }
    return 0;
  }

  function buildNenseiByRow(display) {
    const result = [];
    let currentLevel = 0;
    display.forEach((row, index) => {
      const rowText = (row || [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
      const detected = extractNenseiFromText(rowText);
      if (detected) currentLevel = detected;
      result[index] = currentLevel;
    });
    return result;
  }

  function extractNenseiFromText(value) {
    const text = String(value || '')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[–—−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    const arabic = text.match(/(?:^|\s|[^0-9])([1-6])\s*(?:ST|ND|RD|TH)?\s*NENSEI(?:\s|$|[^A-Z])/i);
    if (arabic) return Number(arabic[1]);

    const romanMap = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
    const roman = text.match(/(?:^|\s|[^A-Z])(VI|IV|V|III|II|I)\s*NENSEI(?:\s|$|[^A-Z])/i);
    return roman ? (romanMap[roman[1].toUpperCase()] || 0) : 0;
  }

  function buildParticipation(rawRow, displayRow, column, notEligible) {
    if (notEligible) {
      return {
        code: 'NOT_ELIGIBLE',
        label: 'NOT ELIGIBLE',
        participated: false,
        eligible: false
      };
    }
    const checked = checkboxIsChecked(rawRow[column - 1], displayRow[column - 1]);
    return {
      code: checked ? 'PARTICIPATED' : 'NOT_PARTICIPATED',
      label: checked ? 'PARTICIPATED' : 'NOT PARTICIPATED',
      participated: checked,
      eligible: true
    };
  }

  function checkboxIsChecked(rawValue, displayValue) {
    if (rawValue === true) return true;
    if (rawValue === false || rawValue === '' || rawValue == null) return false;
    const text = String(displayValue !== '' ? displayValue : rawValue)
      .normalize('NFKC')
      .trim()
      .toUpperCase();
    return ['TRUE', 'YES', 'Y', 'CHECKED', '✓', '✔', '1'].includes(text);
  }

  function getAcademicSubjects(nensei, dormCode, displayRow, displayValues, studentRowIndex) {
    const subjects = [];
    const firstName = detectSubjectNameFromHeaders(
      displayValues, studentRowIndex, 14, 18, ['History of Japanese Magic']
    ) || 'History of Japanese Magic';
    subjects.push(buildAcademicSubject(firstName, displayRow, {
      nak: 14, rawExam: 15, shiken: 16, number: 17, kanji: 18
    }));

    const secondFallback = nensei > 0 && nensei <= 2
      ? 'Magic of The Five Great Elements'
      : 'Art of Incantations';
    const secondName = detectSubjectNameFromHeaders(
      displayValues,
      studentRowIndex,
      19,
      23,
      ['Magic of The Five Great Elements', 'Art of Incantations']
    ) || secondFallback;
    subjects.push(buildAcademicSubject(secondName, displayRow, {
      nak: 19, rawExam: 20, shiken: 21, number: 22, kanji: 23
    }));

    if (nensei >= 3 || hasAcademicValues(displayRow, 24, 33)) {
      const dormSubjects = getDormAcademicSubjects(nensei, dormCode);
      const thirdName = detectSubjectNameFromHeaders(
        displayValues,
        studentRowIndex,
        24,
        28,
        [
          'Warrior Survival Arts',
          'Celestial Magic: Navigating Destiny',
          'Navigating Destiny',
          'Magitech Creation',
          'Dark Sorcery Studies'
        ]
      ) || dormSubjects[0] || 'Dormitory Subject I';

      const fourthName = detectSubjectNameFromHeaders(
        displayValues,
        studentRowIndex,
        29,
        33,
        [
          'Yokaiology',
          'Alchemy Revolution: New Era Insights',
          'Alchemy Revolution',
          'Dark Energy Manipulation'
        ]
      ) || dormSubjects[1] || 'Dormitory Subject II';

      const third = buildAcademicSubject(thirdName, displayRow, {
        nak: 24, rawExam: 25, shiken: 26, number: 27, kanji: 28
      });
      const fourth = buildAcademicSubject(fourthName, displayRow, {
        nak: 29, rawExam: 30, shiken: 31, number: 32, kanji: 33
      });
      if (academicSubjectHasData(third) || nensei >= 3) subjects.push(third);
      if (academicSubjectHasData(fourth) || nensei >= 3) subjects.push(fourth);
    }

    return subjects;
  }

  function getDormAcademicSubjects(nensei, dormCode) {
    if (nensei < 3) return [];
    if (dormCode === 'KSI') return ['Warrior Survival Arts', 'Yokaiology'];
    if (dormCode === 'TSY') {
      return [
        nensei >= 5 ? 'Magitech Creation' : 'Celestial Magic: Navigating Destiny',
        'Alchemy Revolution: New Era Insights'
      ];
    }
    if (dormCode === 'YMY') return ['Dark Sorcery Studies', 'Dark Energy Manipulation'];
    return [];
  }

  function detectSubjectNameFromHeaders(displayValues, studentRowIndex, startColumn, endColumn, candidates) {
    const firstRow = Math.max(0, studentRowIndex - 20);
    const normalizedCandidates = (candidates || []).map(candidate => ({
      original: candidate,
      normalized: normalizeComparableText(candidate)
    }));

    for (let rowIndex = studentRowIndex - 1; rowIndex >= firstRow; rowIndex--) {
      const text = (displayValues[rowIndex] || [])
        .slice(startColumn - 1, endColumn)
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
      const normalized = normalizeComparableText(text);
      if (!normalized) continue;
      for (const candidate of normalizedCandidates) {
        if (normalized.includes(candidate.normalized) || candidate.normalized.includes(normalized)) {
          return candidate.original;
        }
      }
    }
    return '';
  }

  function buildAcademicSubject(name, displayRow, columns) {
    return {
      name: name || '-',
      nak: cleanAcademicMark(displayRow[columns.nak - 1]),
      rawExam: cleanAcademicMark(displayRow[columns.rawExam - 1]),
      shiken: cleanAcademicMark(displayRow[columns.shiken - 1]),
      numberMark: cleanAcademicMark(displayRow[columns.number - 1]),
      kanjiMark: cleanAcademicMark(displayRow[columns.kanji - 1])
    };
  }

  function hasAcademicValues(row, startColumn, endColumn) {
    for (let column = startColumn; column <= endColumn; column++) {
      if (String(row[column - 1] || '').trim() !== '') return true;
    }
    return false;
  }

  function academicSubjectHasData(subject) {
    return [subject.nak, subject.rawExam, subject.shiken, subject.numberMark, subject.kanjiMark]
      .some(value => value !== '-');
  }

  function calculateAcademicAverage(subjects) {
    const numbers = (subjects || [])
      .map(subject => parseFlexibleNumber(subject.numberMark))
      .filter(value => value !== null);
    if (!numbers.length) return '-';
    const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    return formatPlainNumber(Math.round(average * 100) / 100);
  }

  function cleanAcademicMark(value) {
    const text = String(value == null ? '' : value).normalize('NFKC').trim();
    return text || '-';
  }

  function cleanAcademicText(value) {
    const text = String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
    return text || '-';
  }

  function buildXProfile(value) {
    const text = String(value || '').trim();
    if (!text) return { username: '', url: '' };

    const urlMatch = text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
    if (urlMatch) {
      return {
        username: `@${urlMatch[1]}`,
        url: `https://x.com/${urlMatch[1]}`
      };
    }

    const username = text.replace(/^@/, '').replace(/\s+/g, '');
    if (/^[A-Za-z0-9_]{1,30}$/.test(username)) {
      return { username: `@${username}`, url: `https://x.com/${username}` };
    }
    return { username: text, url: '' };
  }

  function buildMediaInfo(value, size) {
    const raw = String(value || '').trim();
    if (!raw) {
      return {
        raw: '',
        fileId: '',
        url: '',
        previewUrl: '',
        previewUrls: []
      };
    }

    const fileId = extractDriveId(raw);
    if (fileId) {
      const previewUrls = makeDriveImageUrls(fileId, size || 'w1200');
      return {
        raw,
        fileId,
        url: makeDriveViewUrl(fileId),
        previewUrl: previewUrls[0] || '',
        previewUrls
      };
    }

    if (/^https?:\/\//i.test(raw)) {
      return {
        raw,
        fileId: '',
        url: raw,
        previewUrl: raw,
        previewUrls: [raw]
      };
    }

    return {
      raw,
      fileId: '',
      url: '',
      previewUrl: '',
      previewUrls: []
    };
  }

  /*
   * Endpoint pertama sengaja memakai drive.google.com/thumbnail.
   * Ini sama dengan endpoint yang dipakai proyek Apps Script asli dan
   * lebih stabil untuk file gambar Drive publik daripada URL lh3 langsung.
   * URL lain disediakan sebagai fallback bila Google mengubah respons CDN.
   */
  function makeDriveImageUrls(fileId, size) {
    if (!fileId) return [];
    const id = encodeURIComponent(fileId);
    const width = String(size || 'w1200').replace(/[^0-9]/g, '') || '1200';

    return [
      `https://drive.google.com/thumbnail?id=${id}&sz=w${width}`,
      `https://lh3.googleusercontent.com/d/${id}=w${width}`,
      `https://drive.google.com/uc?export=view&id=${id}`
    ];
  }

  function makeDriveImageUrl(fileId, size) {
    return makeDriveImageUrls(fileId, size)[0] || '';
  }

  function makeDriveViewUrl(fileId) {
    return fileId
      ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
      : '';
  }

  function extractDriveId(value) {
    const text = String(value || '').trim();
    let match = text.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (match) return match[1];
    match = text.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (match) return match[1];
    match = text.match(/^([a-zA-Z0-9_-]{20,})$/);
    return match ? match[1] : '';
  }

  async function fetchTable({
    spreadsheetId,
    sheet,
    range = '',
    tq = '',
    bypassCache = false
  }) {
    const cacheKey = [spreadsheetId, sheet, range, tq].join('|');
    const cached = tableCache.get(cacheKey);
    if (
      !bypassCache &&
      cached &&
      Date.now() - cached.savedAt < CONFIG.CACHE_TTL_MS
    ) {
      return cached.value;
    }

    const params = new URLSearchParams();
    params.set('tqx', 'out:json');
    params.set('headers', '0');
    params.set('sheet', sheet);
    if (range) params.set('range', range);
    if (tq) params.set('tq', tq);
    params.set('_', String(Math.floor(Date.now() / CONFIG.CACHE_TTL_MS)));

    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?${params.toString()}`;
    const response = await fetch(url, { cache: 'no-store', mode: 'cors' });
    if (!response.ok) throw new Error(`gviz HTTP ${response.status} untuk sheet "${sheet}".`);

    const text = await response.text();
    const payload = parseGvizResponse(text);
    if (!payload || payload.status === 'error') {
      const detail = payload && payload.errors && payload.errors[0]
        ? (payload.errors[0].detailed_message || payload.errors[0].message)
        : 'Respons gviz tidak valid.';
      throw new Error(`${detail} [${sheet}]`);
    }

    const value = tableToMatrices(payload.table || { cols: [], rows: [] });
    value.gvizSig = String(payload.sig || '');

    if (!bypassCache) {
      tableCache.set(cacheKey, { savedAt: Date.now(), value });
    }

    return value;
  }

  function parseGvizResponse(text) {
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start < 0 || end <= start) throw new Error('Format respons gviz tidak dikenali.');
    const body = text.slice(start + 1, end)
      .replace(/:\s*(?:new\s+)?Date\(([^)]*)\)/g, (_match, args) =>
        `:"__GVIZ_DATE__:${args}"`
      );
    return JSON.parse(body);
  }

  function tableToMatrices(table) {
    const width = Math.max((table.cols || []).length, 1);
    const display = [];
    const raw = [];

    (table.rows || []).forEach(row => {
      const displayRow = new Array(width).fill('');
      const rawRow = new Array(width).fill('');
      const cells = row && Array.isArray(row.c) ? row.c : [];
      for (let index = 0; index < width; index++) {
        const cell = cells[index];
        if (!cell) continue;
        const rawValue = decodeGvizValue(cell.v);
        rawRow[index] = rawValue;
        displayRow[index] = cell.f != null
          ? String(cell.f)
          : displayValue(rawValue);
      }
      display.push(displayRow);
      raw.push(rawRow);
    });

    return { display, raw, cols: table.cols || [] };
  }

  function decodeGvizValue(value) {
    if (typeof value === 'string' && value.startsWith('__GVIZ_DATE__:')) {
      const parts = value.slice('__GVIZ_DATE__:'.length)
        .split(',')
        .map(part => Number(part.trim()));
      const date = new Date(
        parts[0] || 0,
        parts[1] || 0,
        parts[2] || 1,
        parts[3] || 0,
        parts[4] || 0,
        parts[5] || 0,
        parts[6] || 0
      );
      return isNaN(date.getTime()) ? value : date;
    }
    return value == null ? '' : value;
  }

  function displayValue(value) {
    if (value instanceof Date) return formatDateTime(value);
    if (value === true) return 'TRUE';
    if (value === false) return 'FALSE';
    return value == null ? '' : String(value);
  }

  function chooseCellValue(display, raw) {
    const displayText = String(display == null ? '' : display).trim();
    if (/^https?:\/\//i.test(displayText) || extractDriveId(displayText)) return displayText;
    const rawText = String(raw == null ? '' : raw).trim();
    return rawText || displayText;
  }

  function normalizeId(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .trim();
  }

  function idsMatch(left, right) {
    const a = normalizeId(left);
    const b = normalizeId(right);
    return Boolean(a && b && a === b);
  }

  function isLikelyStudentId(value) {
    const id = normalizeId(value);
    return id.length >= 7 && /\d/.test(id) && /[A-Z]/.test(id);
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSemesterNumber(name) {
    const text = String(name || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/[．。]/g, '.')
      .replace(/[–—−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();

    const arabic = text.match(/\b(\d{1,3})\b/);
    if (arabic) return Number(arabic[1]);
    const romanTokens = text.match(/\b[IVXLCDM]{1,8}\b/g) || [];
    for (const token of romanTokens) {
      const value = romanToNumber(token);
      if (value > 0) return value;
    }
    return -1;
  }

  function romanToNumber(roman) {
    const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const text = String(roman || '').toUpperCase();
    let total = 0;
    let previous = 0;
    for (let index = text.length - 1; index >= 0; index--) {
      const current = values[text[index]] || 0;
      total += current < previous ? -current : current;
      previous = current;
    }
    return total;
  }

  function numberToRoman(number) {
    const values = [
      [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
      [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
      [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
    ];
    let value = Number(number) || 0;
    let output = '';
    values.forEach(([amount, symbol]) => {
      while (value >= amount) {
        output += symbol;
        value -= amount;
      }
    });
    return output;
  }

  function deriveGenerationLabel(studentId) {
    const match = normalizeId(studentId).match(/^(\d{2})/);
    if (!match) return 'GEN. -';
    const generation = 2000 + Number(match[1]) - CONFIG.GENERATION_BASE_YEAR + 1;
    return generation >= 1 && generation <= 99
      ? `GEN. ${String(generation).padStart(2, '0')}`
      : 'GEN. -';
  }

  function parseFlexibleNumber(value) {
    let text = String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[^0-9,+\-.]/g, '');
    if (!text) return null;

    const comma = text.lastIndexOf(',');
    const dot = text.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      if (comma > dot) text = text.replace(/\./g, '').replace(',', '.');
      else text = text.replace(/,/g, '');
    } else if (comma >= 0) {
      const decimals = text.length - comma - 1;
      text = decimals > 0 && decimals <= 2
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
    }

    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function formatPlainNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
    return Number.isInteger(value)
      ? String(value)
      : String(Math.round(value * 100) / 100);
  }

  function coerceDate(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value;
    if (typeof value === 'number' && value > 0) {
      const date = new Date(new Date(1899, 11, 30).getTime() + value * 86400000);
      return isNaN(date.getTime()) ? null : date;
    }

    const text = String(value || '').trim();
    if (!text) return null;
    const localMatch = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (localMatch) {
      const date = new Date(
        Number(localMatch[3]),
        Number(localMatch[2]) - 1,
        Number(localMatch[1]),
        Number(localMatch[4] || 0),
        Number(localMatch[5] || 0),
        Number(localMatch[6] || 0)
      );
      return isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(text);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDateTime(value) {
    const date = coerceDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date).replace(' at ', ', ');
  }

  function formatDateLong(value) {
    const date = coerceDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.TIME_ZONE,
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }).format(date);
  }

  function extractDateRangeFromText(text) {
    const monthMap = {
      JANUARI: 0, FEBRUARI: 1, MARET: 2, APRIL: 3, MEI: 4, JUNI: 5,
      JULI: 6, AGUSTUS: 7, SEPTEMBER: 8, OKTOBER: 9, NOVEMBER: 10, DESEMBER: 11,
      JANUARY: 0, FEBRUARY: 1, MARCH: 2, MAY: 4, JUNE: 5, JULY: 6,
      AUGUST: 7, OCTOBER: 9, DECEMBER: 11
    };
    const source = String(text || '').normalize('NFKC').toUpperCase();
    const regex = /(\d{1,2})\s+(JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER|JANUARY|FEBRUARY|MARCH|MAY|JUNE|JULY|AUGUST|OCTOBER|DECEMBER)\s+(\d{4})/g;
    const dates = [];
    let match;
    while ((match = regex.exec(source)) !== null) {
      dates.push(new Date(Number(match[3]), monthMap[match[2]], Number(match[1])));
    }
    if (dates.length < 2) return null;
    const start = dates[0];
    const end = dates[1];
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  function padRow(row, length) {
    const output = Array.isArray(row) ? row.slice() : [];
    while (output.length < length) output.push('');
    return output;
  }

  function sanitizeFileName(value) {
    return String(value || 'REPORT.pdf')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_');
  }

  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        output[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return output;
  }

  async function safeResult(factory, fallback) {
    try {
      return await factory();
    } catch (error) {
      console.warn(error);
      return fallback;
    }
  }

  return {
    getStudentData,
    getAcademicPdfPayload,
    getLatestPromotionRecap
  };
})();


const AUTO_REFRESH_MS=60000;let currentStudentId='',refreshTimer=null,pdfBusy=false,promotionData=null,currentTheme='front',pendingPdfWindow=null;
    const PROMOTION_LOGO_DATA_URL='data:image/png;base64,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';
    const $=id=>document.getElementById(id);
    window.addEventListener('load',()=>{renderDecorations('front');$('idInput').addEventListener('keydown',e=>{if(e.key==='Enter')searchGakusei()});const q=new URLSearchParams(location.search);const initial=q.get('id')||sessionStorage.getItem('lastGakuseiId')||'';if(initial){$('idInput').value=initial;searchGakusei()}});

    function searchGakusei(){const id=$('idInput').value.trim();if(!id){setStatus('Type your Gakusei ID number...');return}fetchStudent(id,false)}
    async function fetchStudent(id,silent){
      if(!silent){
        $('searchButton').disabled=true;
        $('resultSection').classList.add('hidden');
        setStatus('Loading student data...');
      }
      try{
        const response=await GakuseiDataService.getStudentData(id);
        renderStudent(response,silent);
      }catch(error){
        if(!silent)$('searchButton').disabled=false;
        setStatus('Error: '+(error.message||error));
      }
    }
    function renderStudent(response,silent){$('searchButton').disabled=false;if(!response||!response.success){setStatus(response&&response.message?response.message:'Student not found.');return}const d=response.data||{},dorm=d.asrama||{},status=d.status||{};applyTheme(dorm.theme);text('studentName',d.namaLatin||'-');text('studentKanji',d.namaKanji||'-');text('studentId',d.nomorId||'-');text('currentGrade',d.tingkatKelas||'-');text('birthDate',d.tanggalLahir||'-');text('financeBalance',d.financeBalance||'-');renderX(d.usernameX,d.usernameXLink);renderBadges(status,d.rank);renderPhoto(d.foto);renderDorm(dorm);renderOccupations(d.daftarPekerjaan||[]);renderAcademic(d.academicRecords||{});renderIdCard(d.idCard);renderPoints(d.studentPoint||{});$('resultSection').classList.remove('hidden');currentStudentId=d.nomorId||'';sessionStorage.setItem('lastGakuseiId',currentStudentId);const url=new URL(location.href);url.searchParams.set('id',currentStudentId);history.replaceState({},'',url);startRefresh();setStatus(silent?'Student record refreshed.':'Student data found.')}
    function text(id,value){$(id).textContent=value==null?'':String(value)}
    function setStatus(value){text('statusLine',value||'')}
    function renderX(username,url){const box=$('xUsername');box.innerHTML='';if(!url){box.textContent=username||'-';return}const a=document.createElement('a');a.className='xLink';a.href=url;a.target='_blank';a.rel='noopener';a.innerHTML='<span>'+escapeHtml(username||'-')+'</span><span class="xMark">𝕏</span>';box.appendChild(a)}
    function renderBadges(status,rank){const box=$('badges');box.innerHTML='';box.appendChild(badge(status.label||'ACTIVE',status.theme==='leave'?'leave':'active'));const r=String(rank||'-').toLowerCase();box.appendChild(badge(rank||'-',r.includes('1st')?'first':r.includes('2nd')?'second':''))}
    function badge(label,cls){const e=document.createElement('span');e.className='badge '+cls;e.textContent=label;return e}
    function uniqueImageUrls(urls){return Array.from(new Set((Array.isArray(urls)?urls:[]).filter(Boolean)))}
    function loadImageFallback(img,urls,onExhausted){const candidates=uniqueImageUrls(urls);let index=0;const tryNext=()=>{if(index>=candidates.length){img.onerror=null;if(typeof onExhausted==='function')onExhausted();return}img.src=cache(candidates[index++])};img.onerror=tryNext;tryNext()}
    function mediaImageUrls(media){if(!media)return[];const urls=[];if(Array.isArray(media.previewUrls))urls.push(...media.previewUrls);if(media.previewUrl)urls.push(media.previewUrl);return uniqueImageUrls(urls)}
    function renderPhoto(media){const box=$('profileAvatar');box.innerHTML='';const urls=mediaImageUrls(media);if(!urls.length){box.innerHTML='<div class="empty">NO PHOTO</div>';return}const img=new Image();img.alt='Student photo';img.referrerPolicy='no-referrer';box.appendChild(img);loadImageFallback(img,urls,()=>{box.innerHTML='<div class="empty">PHOTO UNAVAILABLE</div>'})}
    function renderDorm(dorm){const box=$('dormCrest');box.innerHTML='';const urls=uniqueImageUrls([...(Array.isArray(dorm.logoUrls)?dorm.logoUrls:[]),dorm.logoUrl]);if(urls.length){const img=new Image();img.alt=(dorm.name||'Dormitory')+' crest';img.referrerPolicy='no-referrer';box.appendChild(img);loadImageFallback(img,urls,()=>img.remove())}const label=document.createElement('div');label.className='crestName';label.textContent=dorm.name||'UNASSIGNED';box.appendChild(label)}
    function renderOccupations(items){const box=$('occupationList');box.innerHTML='';if(!items.length){box.innerHTML='<div class="empty">No occupation data was found.</div>';return}items.forEach((item,index)=>{const card=document.createElement('div');card.className='occupation'+(items.length===1?' single':'');if(items.length>1){const no=document.createElement('div');no.className='occupationNo';no.textContent=String(index+1).padStart(2,'0');card.appendChild(no)}const info=document.createElement('div');info.innerHTML='<div class="workplace">'+escapeHtml(item.workplace||'-')+'</div><div class="position">'+escapeHtml(item.position||'-')+'</div>';card.appendChild(info);box.appendChild(card)})}

    function renderAcademic(data){
      const box=$('academicRecords');

      /*
       * Hanya semester yang benar-benar memiliki sumber data
       * yang ditampilkan pada website.
       *
       * Record dengan sourceAvailable === false tidak ditampilkan,
       * karena siswa bisa saja sudah lulus, drop out, atau memang
       * tidak lagi tercatat pada semester berikutnya.
       */
      const allRecords=Array.isArray(data.records)?data.records:[];
      const records=allRecords.filter(record=>
        record &&
        record.sourceAvailable!==false
      );

      const recordedCount=records.length;

      box.innerHTML='';
      text('academicCount',recordedCount+' RECORDED');
      $('ledgerButton').disabled=recordedCount<1;

      if(!records.length){
        box.innerHTML=
          '<div class="empty">'+
            escapeHtml(
              data.message||
              'No recorded academic semester was found for this student.'
            )+
          '</div>';
        return;
      }

      records.forEach(record=>{
        const card=document.createElement('section');
        card.className='semesterCard';
        card.innerHTML=
          '<div class="semesterHead">'+
            '<div class="semesterTitle">'+escapeHtml(record.semesterTitle||'-')+'</div>'+
            '<div class="nensei">'+escapeHtml(record.nenseiLabel||'-')+'</div>'+
          '</div>';

        card.appendChild(miniTitle('Activity Participation'));

        const parts=document.createElement('div');
        parts.className='participation';
        [
          ['Quidditch',record.participation&&record.participation.quidditch],
          ['Combat',record.participation&&record.participation.combat],
          ['Quest',record.participation&&record.participation.quest],
          ['Shiken',record.participation&&record.participation.shiken]
        ].forEach(item=>parts.appendChild(partCard(item[0],item[1])));
        card.appendChild(parts);

        card.appendChild(miniTitle('Subject Results'));

        const subjects=document.createElement('div');
        subjects.className='subjects';
        subjects.innerHTML=
          '<div class="subjectHeader">'+
            '<span>Subject</span>'+
            '<span>Number Mark</span>'+
            '<span>Kanji Mark</span>'+
          '</div>';

        (record.subjects||[]).forEach(subject=>{
          const row=document.createElement('div');
          row.className='subjectRow';
          row.innerHTML=
            '<div class="subjectName">'+escapeHtml(subject.name||'-')+'</div>'+
            '<div class="mark numberMark">'+escapeHtml(subject.numberMark||'-')+'</div>'+
            '<div class="mark kanjiMark">'+escapeHtml(subject.kanjiMark||'-')+'</div>';
          subjects.appendChild(row);
        });
        card.appendChild(subjects);

        const foot=document.createElement('div');
        foot.className='semesterFoot';
        foot.appendChild(
          outcomeCard(
            'Grade Status',
            record.gradeStatus,
            gradeClass(record.gradeStatus)
          )
        );
        foot.appendChild(
          outcomeCard(
            'Ranking Result',
            record.rankingResult,
            rankClass(record.rankingResult)
          )
        );

        const button=document.createElement('button');
        button.type='button';
        button.className='reportButton';
        button.textContent='VIEW DETAIL';
        button.onclick=()=>requestPdf('semester',record.sheetName,button);
        foot.appendChild(button);

        card.appendChild(foot);
        box.appendChild(card);
      });
    }

    function miniTitle(value){const e=document.createElement('div');e.className='miniTitle';e.textContent=value;return e}
    function partCard(name,status){const code=status&&status.code||'NOT_PARTICIPATED';const e=document.createElement('div');e.className='part '+(code==='PARTICIPATED'?'yes':code==='NOT_ELIGIBLE'?'locked':'no');e.innerHTML='<div class="partName">'+name+'</div><div class="partState">'+escapeHtml(status&&status.label||'NOT PARTICIPATED')+'</div>';return e}
    function outcomeCard(label,value,cls){const e=document.createElement('div');e.className='outcome';e.innerHTML='<div class="outcomeLabel">'+label+'</div><div class="outcomeValue '+cls+'">'+escapeHtml(value||'-')+'</div>';return e}
    function gradeClass(value){const v=String(value||'').toUpperCase();return v.includes('PROMOTED')?'promoted':v.includes('RETAINED')?'retained':''}
    function rankClass(value){const v=String(value||'').toUpperCase();return v.includes('1ST')?'rank1':v.includes('2ND')?'rank2':''}
    function downloadLedger(button){requestPdf('ledger','',button)}
    function requestPdf(mode,sheetName,button){
      if(pdfBusy||!currentStudentId)return;

      const normalizedMode=String(mode||'').toLowerCase();
      const openInViewer=['semester','ledger'].includes(normalizedMode);
      let viewerWindow=null;

      if(openInViewer){
        viewerWindow=window.open('','_blank');
        if(viewerWindow){
          viewerWindow.document.open();
          viewerWindow.document.write(
            '<!DOCTYPE html><html><head><title>Preparing academic record...</title>'+
            '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#ead7b7;font:700 16px Arial,sans-serif}div{text-align:center}small{display:block;margin-top:10px;color:#a99b8d;font-weight:400}</style>'+
            '</head><body><div>PREPARING PDF<small>Please keep this tab open.</small></div></body></html>'
          );
          viewerWindow.document.close();
        }
      }

      pdfBusy=true;
      const old=button.textContent;
      button.disabled=true;
      button.textContent=openInViewer?'OPENING PDF...':'BUILDING PDF...';
      showPdf(openInViewer?'Preparing PDF viewer...':'Loading ledger data...');

      GakuseiDataService.getAcademicPdfPayload(
        currentStudentId,
        sheetName,
        mode
      )
        .then(payload=>buildAcademicPdf(payload,{openInViewer:openInViewer,viewerWindow:viewerWindow}))
        .then(result=>{
          setStatus(
            result==='opened'
              ? (
                  normalizedMode==='ledger'
                    ? 'Complete academic ledger opened in a new PDF tab.'
                    : 'Academic record opened in a new PDF tab.'
                )
              : 'PDF downloaded.'
          );
        })
        .catch(error=>{
          if(viewerWindow&&!viewerWindow.closed)viewerWindow.close();
          setStatus('PDF error: '+(error.message||error));
        })
        .finally(()=>{
          pdfBusy=false;
          hidePdf();
          button.disabled=false;
          button.textContent=old;
        });
    }

    function renderIdCard(media){const preview=$('idCardPreview'),action=$('idCardAction');preview.innerHTML='';action.innerHTML='';action.classList.add('hidden');if(!media||!media.raw){preview.innerHTML='<div class="empty">ID CARD UNAVAILABLE</div>';return}const urls=mediaImageUrls(media);if(urls.length){const img=new Image();img.alt='Gakusei ID Card';img.referrerPolicy='no-referrer';preview.appendChild(img);loadImageFallback(img,urls,()=>{preview.innerHTML='<div class="empty">ID CARD PREVIEW UNAVAILABLE</div>'})}else{preview.innerHTML='<div class="empty">ID CARD PREVIEW UNAVAILABLE</div>'}if(media.url){const a=document.createElement('a');a.href=media.url;a.target='_blank';a.rel='noopener';a.className='openButton gradientButton';a.textContent='📇 OPEN ID CARD / NAMETAG';action.appendChild(a);action.classList.remove('hidden')}}
    function renderPoints(data){const totals=data.totals||{};text('semesterBadge',data.semesterTitle||'CURRENT SEMESTER');text('totalGp',pointTotal(totals.gp,'GP'));text('totalRp',pointTotal(totals.rp,'RP'));text('totalFhp',pointTotal(totals.fhp,'FHP'));text('pointUpdated',data.spreadsheetUpdatedAt?'Updated: '+data.spreadsheetUpdatedAt:'');const box=$('pointLogs');box.innerHTML='';const logs=Array.isArray(data.logs)?data.logs:[];if(!logs.length){box.innerHTML='<div class="empty">'+escapeHtml(data.message||'No point log found.')+'</div>';return}logs.forEach(item=>{const row=document.createElement('div');row.className='logItem';const chips=[['gp',item.gp],['rp',item.rp],['fhp',item.fhp]].filter(x=>x[1]&&x[1].hasValue).map(x=>'<span class="chip '+x[0]+'">'+escapeHtml(x[1].text)+'</span>').join('');row.innerHTML='<div class="logDate">'+escapeHtml(item.date||'-')+'</div><div><div class="logDesc">'+escapeHtml(item.description||'-')+'</div><div class="chips">'+chips+'</div></div>';box.appendChild(row)})}
    function pointTotal(value,code){let v=String(value==null||value===''?'0':value).trim().replace(new RegExp(code+'$','i'),'').trim();return(v||'0')+code}

    async function openPromotionRecap(){
      $('promotionModal').classList.remove('hidden');
      $('promotionContent').innerHTML='<div class="empty">Loading...</div>';
      try{
        const data=await GakuseiDataService.getLatestPromotionRecap();
        if(!data||!data.success){
          $('promotionContent').innerHTML='<div class="empty">'+escapeHtml(data&&data.message||'Unable to load.')+'</div>';
          return;
        }
        promotionData=data;
        renderPromotion(data);
      }catch(error){
        $('promotionContent').innerHTML='<div class="empty">'+escapeHtml(error.message||error)+'</div>';
      }
    }
    function closePromotionRecap(){$('promotionModal').classList.add('hidden')}
    function renderPromotion(data){text('modalSub','Latest semester: '+(data.semesterTitle||'-')+' • Updated: '+(data.generatedAt||'-'));const s=data.summary||{},rows=data.rows||[];let html='<div class="summary">'+summaryCard('Total Students',s.total||0)+summaryCard('Promoted',s.promoted||0)+summaryCard('Retained',s.retained||0)+summaryCard('Unspecified',s.unspecified||0)+'</div><div class="tableWrap"><table class="recapTable"><thead><tr><th>No.</th><th>ID</th><th>Student</th><th>Dormitory</th><th>Grade</th><th>Status</th><th>Ranking</th><th>Remarks</th></tr></thead><tbody>';rows.forEach((row,index)=>{html+='<tr><td>'+(index+1)+'</td><td>'+escapeHtml(row.nomorId)+'</td><td>'+escapeHtml(row.namaLatin)+'</td><td>'+escapeHtml(row.asrama)+'</td><td>'+escapeHtml(row.nenseiLabel)+'</td><td>'+escapeHtml(row.gradeStatus)+'</td><td>'+escapeHtml(row.rankingResult)+'</td><td>'+escapeHtml(row.remarks)+'</td></tr>'});html+='</tbody></table></div>';$('promotionContent').innerHTML=html}
    function summaryCard(label,value){return'<div class="summaryCard"><div class="summaryLabel">'+label+'</div><div class="summaryValue">'+value+'</div></div>'}
    async function downloadPromotionPdf(){
      if(!promotionData||pdfBusy)return;

      let viewerWindow=window.open('','_blank');

      if(viewerWindow){
        viewerWindow.document.open();
        viewerWindow.document.write(
          '<!DOCTYPE html><html><head><title>Preparing Nensei Promotion Recap...</title>'+
          '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#ead7b7;font:700 16px Arial,sans-serif}div{text-align:center}small{display:block;margin-top:10px;color:#a99b8d;font-weight:400}</style>'+
          '</head><body><div>PREPARING PDF<small>Please keep this tab open.</small></div></body></html>'
        );
        viewerWindow.document.close();
      }

      pdfBusy=true;
      showPdf('Preparing Nensei Promotion Recap...');

      try{
        const root=$('pdfRoot');
        root.innerHTML='';

        const pages=createPromotionPages(promotionData);
        pages.forEach(page=>root.appendChild(page));

        await waitImages(root);

        const result=await capturePages(
          pages,
          'MAHOUTOKORO_NENSEI_PROMOTION_RECAP_'+safeName(promotionData.semesterTitle)+'.pdf',
          {
            openInViewer:true,
            viewerWindow:viewerWindow
          }
        );

        root.innerHTML='';

        setStatus(
          result==='opened'
            ? 'Nensei Promotion Recap opened in a new PDF tab.'
            : 'PDF downloaded.'
        );
      }catch(error){
        if(viewerWindow&&!viewerWindow.closed)viewerWindow.close();
        setStatus('PDF error: '+error.message);
      }finally{
        pdfBusy=false;
        hidePdf();
      }
    }
    function normalizePromotionStatus(value){
      return String(value||'')
        .normalize('NFKC')
        .trim()
        .toUpperCase();
    }

    function createPromotionPages(data){
      const allRows=Array.isArray(data&&data.rows)?data.rows:[];
      const promotedRows=allRows.filter(row=>normalizePromotionStatus(row.gradeStatus).includes('PROMOTED'));
      const retainedRows=allRows.filter(row=>normalizePromotionStatus(row.gradeStatus).includes('RETAINED'));

      return [
        ...createPromotionGroupPages(data,promotedRows,{
          title:'PROMOTED STUDENTS',
          className:'promotedGroup'
        }),
        ...createPromotionGroupPages(data,retainedRows,{
          title:'RETAINED STUDENTS',
          className:'retainedGroup'
        })
      ];
    }

    function createPromotionGroupPages(data,rows,group){
      /*
       * Satu status selalu dimulai pada lembar baru.
       * Di dalam status yang sama, siswa dimasukkan sebanyak
       * mungkin ke halaman aktif. Halaman baru hanya dibuat
       * ketika tinggi tabel diperkirakan sudah tidak cukup.
       */
      const pageChunks=paginatePromotionRows(rows);
      if(!pageChunks.length)pageChunks.push([]);

      return pageChunks.map((pageRows,pageIndex)=>{
        const page=pdfPage('promotionPage');
        const totalPages=pageChunks.length;
        const firstNumber=pageChunks
          .slice(0,pageIndex)
          .reduce((total,current)=>total+current.length,0)+1;

        const header=document.createElement('div');
        header.className='promotionHeader';
        header.innerHTML=
          '<div class="promotionLogoWrap">'+
            '<img class="promotionLogo" src="'+PROMOTION_LOGO_DATA_URL+'" alt="Mahoutokoro">'+
          '</div>'+
          '<div>'+
            '<div class="promotionJp jp">進級結果一覧</div>'+
            '<div class="promotionTitle">NENSEI PROMOTION RECAP</div>'+
            '<div class="promotionSub">Mahoutokoro Official Grade Advancement Record</div>'+
          '</div>';
        page.appendChild(header);

        const banner=document.createElement('div');
        banner.className='promotionGroupBanner '+group.className;
        banner.innerHTML=
          '<div class="promotionGroupTitle">'+escapeHtml(group.title)+'</div>'+
          '<div class="promotionGroupMeta">'+
            'SEMESTER '+escapeHtml(data.semesterTitle||'-')+
            ' • GROUP TOTAL '+rows.length+
            ' • PAGE '+(pageIndex+1)+' OF '+totalPages+
          '</div>';
        page.appendChild(banner);

        const summary=document.createElement('div');
        summary.className='promotionSummaryLine';
        summary.textContent=
          'TOTAL STUDENTS: '+Number(data.summary&&data.summary.total||0)+
          '  •  PROMOTED: '+Number(data.summary&&data.summary.promoted||0)+
          '  •  RETAINED: '+Number(data.summary&&data.summary.retained||0);
        page.appendChild(summary);

        if(!pageRows.length){
          const empty=document.createElement('div');
          empty.className='promotionEmpty';
          empty.textContent='NO STUDENT RECORDS IN THIS CATEGORY.';
          page.appendChild(empty);
        }else{
          const table=document.createElement('table');
          table.className='promotionTable';
          table.innerHTML=
            '<thead><tr>'+
              '<th>NO.</th>'+
              '<th>GAKUSEI ID</th>'+
              '<th>STUDENT NAME</th>'+
              '<th>DORMITORY</th>'+
              '<th>NENSEI</th>'+
              '<th>RANKING</th>'+
              '<th>REMARKS</th>'+
            '</tr></thead>';

          const tbody=document.createElement('tbody');

          pageRows.forEach((row,index)=>{
            const tr=document.createElement('tr');
            [
              firstNumber+index,
              row.nomorId||'-',
              row.namaLatin||'-',
              row.asrama||'-',
              row.nenseiLabel||'-',
              row.rankingResult||'-',
              row.remarks||'-'
            ].forEach((value,columnIndex)=>{
              const td=document.createElement('td');
              td.textContent=String(value==null||value===''?'-':value);
              if(columnIndex===2||columnIndex===6)td.style.textAlign='left';
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });

          table.appendChild(tbody);
          page.appendChild(table);
        }

        const footer=document.createElement('div');
        footer.className='promotionPageFooter';
        footer.textContent=
          'MAHOUTOKORO • NENSEI PROMOTION RECAP • '+
          group.title+
          ' • '+(pageIndex+1)+' / '+totalPages;
        page.appendChild(footer);

        return page;
      });
    }

    function paginatePromotionRows(rows){
      const source=Array.isArray(rows)?rows:[];
      if(!source.length)return [];

      /*
       * Area vertikal aman untuk isi tabel pada lembar Legal.
       * Header, banner, summary, dan footer sudah diperhitungkan.
       */
      const MAX_TABLE_HEIGHT=890;
      const MAX_ROWS_PER_PAGE=30;

      const pages=[];
      let currentPage=[];
      let currentHeight=0;

      source.forEach(row=>{
        const rowHeight=estimatePromotionRowHeight(row);

        const pageIsFull=
          currentPage.length>0&&(
            currentPage.length>=MAX_ROWS_PER_PAGE||
            currentHeight+rowHeight>MAX_TABLE_HEIGHT
          );

        if(pageIsFull){
          pages.push(currentPage);
          currentPage=[];
          currentHeight=0;
        }

        currentPage.push(row);
        currentHeight+=rowHeight;
      });

      if(currentPage.length)pages.push(currentPage);
      return pages;
    }

    function estimatePromotionRowHeight(row){
      const safeRow=row||{};

      /*
       * Perkiraan jumlah baris berdasarkan lebar kolom PDF.
       * Remarks diberi ruang paling besar, lalu nama siswa.
       */
      const nameLines=estimateWrappedLines(safeRow.namaLatin,29);
      const dormLines=estimateWrappedLines(safeRow.asrama,15);
      const nenseiLines=estimateWrappedLines(safeRow.nenseiLabel,13);
      const rankingLines=estimateWrappedLines(safeRow.rankingResult,14);
      const remarksLines=estimateWrappedLines(safeRow.remarks,48);

      const lineCount=Math.max(
        1,
        nameLines,
        dormLines,
        nenseiLines,
        rankingLines,
        remarksLines
      );

      /*
       * Satu baris normal kira-kira 25 px.
       * Tambahan baris teks menambah sekitar 10 px.
       */
      return 25+Math.max(0,lineCount-1)*10;
    }

    function estimateWrappedLines(value,charactersPerLine){
      const text=String(value==null||value===''?'-':value)
        .replace(/\s+/g,' ')
        .trim();

      return Math.max(
        1,
        Math.ceil(text.length/Math.max(1,charactersPerLine))
      );
    }

    async function buildAcademicPdf(payload,options){
      if(!payload||!payload.success)throw new Error('Invalid PDF payload.');

      const settings=options||{};
      const copy=JSON.parse(JSON.stringify(payload));
      copy.assets=copy.assets||{};

      showPdf('Preparing transparent hanko...');
      copy.assets.headmasterStamp=await transparentStamp(copy.assets.headmasterStamp,.7);
      copy.assets.studentAffairsStamp=await transparentStamp(copy.assets.studentAffairsStamp,.84);

      const root=$('pdfRoot');
      root.innerHTML='';

      const availableRecords=(copy.records||[]).filter(record=>record.sourceAvailable!==false);
      if(!availableRecords.length)throw new Error('No recorded semester is available for this PDF.');

      const pages=copy.mode==='ledger'
        ? createLedgerPages(copy)
        : availableRecords.map(record=>createReportPage(copy,record));

      pages.forEach(page=>root.appendChild(page));
      await waitImages(root);

      const result=await capturePages(
        pages,
        copy.fileName||'REPORT.pdf',
        settings
      );

      root.innerHTML='';
      return result;
    }

    function createReportPage(payload,record){
      return createAcademicRecordPage(payload,record,{
        documentType:'report',
        pageNumber:1,
        totalPages:1
      });
    }

    function createLedgerPages(payload){
      const records=(payload.records||[]).filter(record=>record.sourceAvailable!==false);
      return records.map((record,index)=>createAcademicRecordPage(payload,record,{
        documentType:'ledger',
        pageNumber:index+1,
        totalPages:records.length
      }));
    }

    function createAcademicRecordPage(payload,record,options){
      const s=payload.student||{};
      const a=payload.assets||{};
      const settings=options||{};
      const isLedger=settings.documentType==='ledger';
      const page=pdfPage('reportPage'+(isLedger?' ledgerRecordPage':''));

      const title=isLedger
        ? 'ACADEMIC LEDGER'
        : 'TEMPORARY ACADEMIC RECORD';

      const subtitle=isLedger
        ? 'Complete recorded semester • Page '+settings.pageNumber+' of '+settings.totalPages
        : 'Official Semester Study Result';

      const head=document.createElement('div');
      head.className='reportHeader';
      head.innerHTML=
        (a.headerLogo
          ? '<img class="reportLogo" src="'+a.headerLogo+'" alt="Mahoutokoro">'
          : '<div></div>')+
        '<div>'+
          '<div class="reportInstitution">MAHOUTOKORO</div>'+
          '<div class="reportTitle">'+title+'</div>'+
          '<div class="reportSub">'+escapeHtml(subtitle)+'</div>'+
        '</div>'+
        '<div class="termBadge">'+
          '<div class="termMain">'+escapeHtml(record.semesterTitle||'-')+'</div>'+
          '<div class="termSub">'+escapeHtml(record.nenseiLabel||'-')+'</div>'+
        '</div>';
      page.appendChild(head);

      const identity=document.createElement('div');
      identity.className='pdfIdentity';
      identity.innerHTML=
        '<div class="pdfPhoto">'+
          (a.photo
            ? '<img src="'+a.photo+'" alt="Student photo">'
            : '<div class="photoFallback">PHOTO UNAVAILABLE</div>')+
        '</div>'+
        '<div>'+
          '<div class="pdfName">'+escapeHtml(s.namaLatin||'-')+'</div>'+
          '<div class="pdfKanji jp">'+escapeHtml(s.namaKanji||'-')+'</div>'+
          '<div class="idGrid">'+
            idItem('Gakusei ID',s.nomorId)+
            idItem('Dormitory',s.asrama&&s.asrama.name)+
            idItem('Semester Grade',record.nenseiLabel)+
            idItem('Current Grade',s.tingkatKelas)+
            idItem('Date of Birth',s.tanggalLahir)+
          '</div>'+
        '</div>';
      page.appendChild(identity);

      const scoreSummary=document.createElement('div');
      scoreSummary.className='pdfScoreSummary';
      scoreSummary.innerHTML=
        pdfScoreCard('Total GP',record.totalGp,'GP')+
        pdfScoreCard('Total FHP',record.totalFhp,'FHP')+
        pdfScoreCard('Average Number Mark',record.averageNumberMark,'');
      page.appendChild(scoreSummary);

      page.appendChild(pdfSection('Activity Participation'));

      const participation=record.participation||{};
      const parts=document.createElement('div');
      parts.className='pdfPartGrid';

      [
        ['Quidditch',participation.quidditch],
        ['Combat',participation.combat],
        ['Quest',participation.quest],
        ['Shiken',participation.shiken]
      ].forEach(item=>{
        const state=item[1]||{code:'NO_SOURCE',label:'NO SOURCE DATA'};
        parts.innerHTML+=
          '<div class="pdfPart">'+
            '<div class="pdfPartName">'+item[0]+'</div>'+
            '<div class="pdfPartState '+
              (state.code==='PARTICIPATED'
                ? 'promoted'
                : state.code==='NOT_ELIGIBLE'
                  ? ''
                  : 'retained')+
            '">'+escapeHtml(state.label||'-')+'</div>'+
          '</div>';
      });
      page.appendChild(parts);

      page.appendChild(pdfSection('Complete Subject Results'));

      const table=document.createElement('table');
      table.className='scoreTable';
      table.innerHTML=
        '<thead><tr>'+
          '<th>SUBJECT</th>'+
          '<th>NAK<br>60%</th>'+
          '<th>RAW<br>EXAM</th>'+
          '<th>SHIKEN / EXAM<br>40%</th>'+
          '<th>MARK<br>NUMBER</th>'+
          '<th>MARK<br>KANJI</th>'+
        '</tr></thead>';

      const tbody=document.createElement('tbody');
      (record.subjects||[]).forEach(subject=>{
        const tr=document.createElement('tr');
        tr.innerHTML=
          '<td class="scoreSubject">'+escapeHtml(subject.name||'-')+'</td>'+
          '<td>'+escapeHtml(subject.nak||'-')+'</td>'+
          '<td>'+escapeHtml(subject.rawExam||'-')+'</td>'+
          '<td>'+escapeHtml(subject.shiken||'-')+'</td>'+
          '<td class="scoreNumber">'+escapeHtml(subject.numberMark||'-')+'</td>'+
          '<td class="scoreKanji">'+escapeHtml(subject.kanjiMark||'-')+'</td>';
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      page.appendChild(table);

      page.appendChild(pdfSection('Semester Outcome'));

      const outcomes=document.createElement('div');
      outcomes.className='pdfOutcome';
      outcomes.innerHTML=
        pdfOutcome('Grade Status',record.gradeStatus,gradeClass(record.gradeStatus))+
        pdfOutcome('Ranking Result',record.rankingResult,rankClass(record.rankingResult))+
        pdfOutcome('Average Number Mark',record.averageNumberMark,'');
      page.appendChild(outcomes);

      const remarks=document.createElement('div');
      remarks.className='pdfRemarks';
      remarks.innerHTML=
        '<div class="pdfRemarksLabel">Remarks / Examination Eligibility</div>'+
        '<div class="pdfRemarksText">'+escapeHtml(record.remarks||'-')+'</div>';
      page.appendChild(remarks);

      const footer=document.createElement('div');
      footer.className='pdfFooter';
      footer.innerHTML=
        '<div class="pdfDate">'+
          'MAHOUTOKORO • '+escapeHtml(payload.generatedDateLatin||'')+
          (isLedger
            ? ' • LEDGER PAGE '+settings.pageNumber+' / '+settings.totalPages
            : '')+
        '</div>'+
        '<div class="signatures">'+
          signature('Mahoutokoro Headmaster',a.headmasterStamp,'Ryoumen Shō')+
          signature('Student Affairs',a.studentAffairsStamp,'Student Affairs Office')+
        '</div>';
      page.appendChild(footer);

      return page;
    }

    function pdfScoreCard(label,value,suffix){
      const raw=String(value==null||value===''?'-':value).trim();
      const normalized=raw==='-'?'-':raw+(suffix&&!new RegExp(suffix+'$','i').test(raw)?' '+suffix:'');
      return '<div class="pdfScoreCard">'+
        '<div class="pdfScoreLabel">'+escapeHtml(label)+'</div>'+
        '<div class="pdfScoreValue">'+escapeHtml(normalized)+'</div>'+
      '</div>';
    }

    function idItem(label,value){return'<div class="idItem"><div class="idLabel">'+label+'</div><div class="idValue">'+escapeHtml(value||'-')+'</div></div>'}
    function pdfSection(value){const e=document.createElement('div');e.className='pdfSection';e.textContent=value;return e}
    function pdfOutcome(label,value,cls){return'<div class="pdfOutcomeCard"><div class="pdfOutcomeLabel">'+label+'</div><div class="pdfOutcomeValue '+cls+'">'+escapeHtml(String(value||'-'))+'</div></div>'}
    function signature(role,url,name){return'<div><div class="signRole">'+role+'</div>'+(url?'<img class="stamp" src="'+url+'">':'<div class="stamp"></div>')+'<div class="signName">'+name+'</div></div>'}
    function pdfPage(cls){const e=document.createElement('section');e.className='pdfPage '+cls;return e}
    async function capturePages(pages,fileName,options){
      if(!window.html2canvas||!window.jspdf)throw new Error('PDF libraries are not ready.');

      const settings=options||{};
      const PDF=window.jspdf.jsPDF;
      let pdf=null;

      for(let i=0;i<pages.length;i++){
        showPdf(
          (settings.openInViewer?'Rendering PDF page ':'Rendering legal page ')+
          (i+1)+' of '+pages.length+'...'
        );

        const canvas=await html2canvas(pages[i],{
          scale:1.9,
          useCORS:true,
          allowTaint:false,
          backgroundColor:'#f5efe4',
          logging:false
        });

        const image=canvas.toDataURL('image/jpeg',.97);

        if(!pdf){
          pdf=new PDF({
            orientation:'portrait',
            unit:'px',
            format:[816,1344],
            compress:true,
            hotfixes:['px_scaling']
          });
        }else{
          pdf.addPage([816,1344],'portrait');
        }

        pdf.addImage(image,'JPEG',0,0,816,1344,'page-'+i,'FAST');
        canvas.width=1;
        canvas.height=1;
      }

      if(settings.openInViewer){
        const blob=pdf.output('blob');
        let pdfObject=blob;

        try{
          pdfObject=new File([blob],fileName,{type:'application/pdf'});
        }catch(error){}

        const objectUrl=URL.createObjectURL(pdfObject);
        let opened=false;

        if(settings.viewerWindow&&!settings.viewerWindow.closed){
          settings.viewerWindow.location.replace(objectUrl);
          opened=true;
        }else{
          const fallbackWindow=window.open(objectUrl,'_blank');
          opened=!!fallbackWindow;
        }

        if(opened){
          setTimeout(()=>URL.revokeObjectURL(objectUrl),15*60*1000);
          return 'opened';
        }

        URL.revokeObjectURL(objectUrl);
        pdf.save(fileName);
        return 'downloaded';
      }

      pdf.save(fileName);
      return 'downloaded';
    }
    function showPdf(value){$('pdfOverlay').classList.remove('hidden');text('pdfText',value)}function hidePdf(){$('pdfOverlay').classList.add('hidden')}
    function waitImages(root){return Promise.all(Array.from(root.querySelectorAll('img')).map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve})))}
    function transparentStamp(dataUrl,opacity){if(!dataUrl)return Promise.resolve('');return new Promise(resolve=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>{try{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<d.data.length;i+=4){const r=d.data[i],g=d.data[i+1],b=d.data[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),neutral=max-min<20;if(r>226&&g>226&&b>226||neutral&&max<68)d.data[i+3]=0;else if(r>g*1.1&&r>b*1.1)d.data[i+3]=Math.round(d.data[i+3]*opacity);else d.data[i+3]=Math.round(d.data[i+3]*opacity*.28)}ctx.putImageData(d,0,0);resolve(c.toDataURL('image/png'))}catch(error){console.warn('Hanko transparency skipped because the public image server did not allow canvas access.',error);resolve(dataUrl)}};img.onerror=()=>resolve(dataUrl);img.src=dataUrl})}

    function applyTheme(theme){document.body.classList.remove('dorm-kosei','dorm-yamiyo','dorm-tsukiyomi');currentTheme=['kosei','yamiyo','tsukiyomi'].includes(theme)?theme:'front';if(currentTheme!=='front')document.body.classList.add('dorm-'+currentTheme);renderDecorations(currentTheme)}
    function renderDecorations(theme){
      const normalized=['kosei','yamiyo','tsukiyomi'].includes(theme)?theme:'front';
      renderPageDecorations_(normalized);
      renderHeroDecorations_(normalized);
    }

    function renderPageDecorations_(theme){
      const box=$('backdrop');
      if(!box)return;
      box.innerHTML='';

      const count=theme==='front'?20:24;

      for(let i=0;i<count;i++){
        const e=document.createElement('span');
        const uid='page-'+theme+'-'+i;

        e.className='faller';
        e.style.left=random(-4,97)+'%';
        e.style.setProperty('--s',random(theme==='front'?86:68,theme==='front'?190:156)+'px');
        e.style.setProperty('--o',random(theme==='front'?.07:.06,theme==='front'?.18:.17));
        e.style.setProperty('--d',random(15,27)+'s');
        e.style.setProperty('--delay',-random(0,27)+'s');
        e.style.setProperty('--x1',random(-110,110)+'px');
        e.style.setProperty('--x2',random(-145,145)+'px');
        e.style.setProperty('--r1',random(-380,380)+'deg');
        e.style.setProperty('--r2',random(-920,920)+'deg');
        e.innerHTML=theme==='front'?scrollSvg(uid):flowerSvg(theme,uid);

        box.appendChild(e);
      }
    }

    function renderHeroDecorations_(theme){
      const box=$('heroBackdrop');
      if(!box)return;
      box.innerHTML='';

      const count=theme==='front'?10:12;

      for(let i=0;i<count;i++){
        const e=document.createElement('span');
        const uid='hero-'+theme+'-'+i;
        const useLeftSide=i%2===0;
        const left=useLeftSide?random(1,24):random(76,96);

        e.className='heroFaller';
        e.style.left=left+'%';
        e.style.setProperty('--s',random(theme==='front'?62:44,theme==='front'?118:86)+'px');
        e.style.setProperty('--o',random(theme==='front'?.16:.15,theme==='front'?.34:.31));
        e.style.setProperty('--d',random(10,17)+'s');
        e.style.setProperty('--delay',-random(0,17)+'s');
        e.style.setProperty('--x1',random(-36,36)+'px');
        e.style.setProperty('--x2',random(-52,52)+'px');
        e.style.setProperty('--r1',random(-300,300)+'deg');
        e.style.setProperty('--r2',random(-720,720)+'deg');
        e.innerHTML=theme==='front'?scrollSvg(uid):flowerSvg(theme,uid);

        box.appendChild(e);
      }
    }
    function scrollSvg(i){return'<svg viewBox="0 0 120 86"><defs><linearGradient id="s'+i+'" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff0d0"/><stop offset=".5" stop-color="#e2c18b"/><stop offset="1" stop-color="#aa7544"/></linearGradient></defs><path d="M17 14C8 14 5 25 12 31L22 32H98C111 34 116 16 102 14Z" fill="#1c1b1c" stroke="#d9b277" stroke-width="2"/><path d="M17 54C8 54 5 65 12 71L22 72H98C111 74 116 56 102 54Z" fill="#171617" stroke="#b77d4a" stroke-width="2"/><path d="M18 23C29 18 91 18 102 23V64C91 69 29 69 18 64Z" fill="url(#s'+i+')" stroke="#7c4d2f"/><circle cx="60" cy="44" r="8" fill="#8c0d15" stroke="#f0d09c"/><text x="60" y="48" text-anchor="middle" font-size="10" fill="#f8e5c4">魔</text></svg>'}
    function flowerSvg(theme,i){if(theme==='kosei'){let petals='';for(let x=0;x<18;x++)petals+='<ellipse cx="32" cy="11" rx="4.7" ry="13.5" fill="url(#p'+i+')" stroke="#bd6b00" stroke-width=".6" transform="rotate('+(x*20)+' 32 32)"/>';return'<svg viewBox="0 0 64 64"><defs><linearGradient id="p'+i+'" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff6a3"/><stop offset=".35" stop-color="#ffe15a"/><stop offset=".72" stop-color="#f4ad13"/><stop offset="1" stop-color="#c96a00"/></linearGradient></defs>'+petals+'<circle cx="32" cy="32" r="14" fill="#5b3218" stroke="#c97805"/></svg>'}if(theme==='yamiyo')return'<svg viewBox="0 0 64 64"><defs><radialGradient id="r'+i+'"><stop stop-color="#ead7f6"/><stop offset=".4" stop-color="#b47bce"/><stop offset="1" stop-color="#17101c"/></radialGradient></defs><path d="M32 4C22 4 16 10 15 17C7 17 2 24 5 32C0 39 4 49 13 51C16 60 26 63 33 58C42 63 52 57 53 49C62 46 64 36 58 29C61 21 54 13 46 14C43 7 36 4 32 4Z" fill="url(#r'+i+')"/><path d="M32 14C24 14 18 21 21 28C15 33 18 42 25 44C27 52 37 53 43 46C51 45 52 35 46 30C48 22 40 16 34 19Z" fill="#744087"/><path d="M31 24C37 21 43 26 40 32C38 37 31 38 29 33C26 29 28 25 31 24Z" fill="#241329"/></svg>';let petals='';[0,72,144,216,288].forEach(a=>petals+='<path d="M0-6C-8-9-14-17-9-25C-5-32 3-33 8-27C14-20 8-11 0-6Z" fill="url(#k'+i+')" transform="rotate('+a+')"/>');return'<svg viewBox="0 0 64 64"><defs><radialGradient id="k'+i+'"><stop stop-color="#fff"/><stop offset=".48" stop-color="#ffe9f2"/><stop offset="1" stop-color="#dc84a8"/></radialGradient></defs><g transform="translate(32 32)">'+petals+'<circle r="6.6" fill="#fff3cf"/></g></svg>'}
    function random(a,b){return Math.random()*(b-a)+a}function cache(url){return String(url)+(String(url).includes('?')?'&':'?')+'v='+Date.now()}function startRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(currentStudentId)fetchStudent(currentStudentId,true)},AUTO_REFRESH_MS)}function escapeHtml(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}function chunk(items,size){const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}function safeName(value){return String(value||'REPORT').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,'_')}
