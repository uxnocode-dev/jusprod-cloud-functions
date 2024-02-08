const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

const { equilizeUserBaseMock } = require("./mock/equilize-user-base.mock");
const { searchProcessMock } = require("./mock/search-process.mock");

admin.initializeApp();
const db = admin.firestore();

//#region utils
function getUnixTimestamp(date = null) {
  const actualDate = new Date(date);
  if (isNaN(actualDate.getTime())) {
    actualDate.setTime(Date.now());
  }

  return Math.floor(actualDate.getTime() / 1000);
}

const handleApiCall = (endpoint, token, method = "get", body) => {
  const headers = { headers: { Authorization: `Bearer ${token}` } };

  if (method === "get") return axios.get(endpoint, headers);
  if (method === "delete") return axios.delete(endpoint, headers);
  else return axios.post(endpoint, body, headers);
};

const getConfig = async () => {
  const data = await getCollectionData("CloudFunctionConfig");
  const getConfigByKey = (key) => data.find((item) => item.key === key).value;

  return {
    api_v1: getConfigByKey("escavador_v1"),
    api_v2: getConfigByKey("escavador_v2"),
    api_token: getConfigByKey("escavador_token"),
  };
};

const removeDuplicate = (list, key) => {
  const seen = new Set();

  return list.filter((el) => {
    const duplicate = seen.has(el[key]);
    seen.add(el[key]);
    return !duplicate;
  });
};

const getMonitoring = async (url = "", items = []) => {
  try {
    const { api_v1, api_token } = await getConfig();
    const endpoint = url || `${api_v1}/monitoramentos?page=1`;
    const { data } = await handleApiCall(endpoint, api_token);

    if (data?.links?.next)
      return await getMonitoring(data?.links?.next, data?.items);
    else return items;
  } catch (error) {
    logger.error("+++ getMonitoring +++", error, { structuredData: true });
    throw error;
  }
};

const getUserOABProcessV1 = async (
  url = "",
  state = "",
  number = "",
  items = []
) => {
  try {
    const { api_v1, api_token } = await getConfig();
    const endpoint = url || `${api_v1}/oab/${state}/${number}/processos?page=1`;
    const { data } = await handleApiCall(endpoint, api_token);

    logger.log(
      `Progress OAB v1: ${number} | ${data.paginator.current_page} of ${data.paginator.total_pages}`,
      { structuredData: true }
    );

    if (data?.links?.next)
      return await getUserOABProcessV1(
        data?.links?.next,
        state,
        number,
        data?.items
      );
    else return items;
  } catch (error) {
    logger.error("+++ EQUALIZE USER BASE +++", error, { structuredData: true });
    throw error;
  }
};

const getUserOABProcessV2 = async (
  url = "",
  state = "",
  number = "",
  items = []
) => {
  try {
    const { api_v2, api_token } = await getConfig();
    const endpoint =
      url ||
      `${api_v2}/advogado/processos?oab_estado=${state}&oab_numero=${number}`;
    const { data } = await handleApiCall(endpoint, api_token);

    logger.log(`Progress OAB v2: ${number}`, { structuredData: true });

    if (data?.links?.next)
      return await getUserOABProcessV2(data?.links?.next, state, number, [
        ...items,
        ...data?.items,
      ]);
    else return items;
  } catch (error) {
    logger.error("+++ EQUALIZE USER BASE +++", error, { structuredData: true });
    throw error;
  }
};

const buildUserProcessList = async (documents) => {
  try {
    const result = [];

    for await (let item of documents) {
      const itemsV2 = await getUserOABProcessV2("", item.state, item.number);
      result.push(...itemsV2);
    }

    return result;
  } catch (error) {
    throw error;
  }
};

const buildUserProcessListByPlan = async (documents, limit) => {
  try {
    const result = [];
    const maxProcesses = limit;
    let processCount = 0;

    for await (let item of documents) {
      if (processCount >= maxProcesses) {
        break;
      }

      const itemsV2 = await getUserOABProcessV2("", item.state, item.number);
      result.push(...itemsV2.slice(0, maxProcesses - processCount));
      processCount += itemsV2.length;

      if (processCount > maxProcesses) {
        result.splice(maxProcesses, result.length - maxProcesses);
        break;
      }
    }

    return result;
  } catch (error) {
    throw error;
  }
};

const buildUserProcessModel = (data, userOABs) => {
  const getPerson = (personData) => ({
    name: personData?.nome,
    type: personData?.tipo,
    isPJ: !!personData?.cnpj,
    typePerson: personData?.tipo_pessoa,
    document: !!personData?.cnpj ? personData?.cnpj : personData?.cpf,
  });

  return data.map((item) => {
    const [tribunal] = item?.fontes;
    const peopleInvolved = tribunal?.envolvidos.map((item) => getPerson(item));

    const lawyers = peopleInvolved.filter(
      (item) => item?.type?.toLowerCase() === "advogado"
    );

    const clients = tribunal?.envolvidos
      .filter((item) => {
        return item?.advogados?.some((advogado) => {
          return userOABs?.some(({ number }) =>
            advogado?.oabs?.some(({ numero }) => numero == number)
          );
        });
      })
      .map((item) => getPerson(item));

    return {
      clients,
      lawyers,
      peopleInvolved,
      cnj: item?.numero_cnj,
      coverJson: tribunal?.capa,
      courtName: tribunal?.descricao,
      plaintiff: item?.titulo_polo_ativo,
      defendant: item?.titulo_polo_passivo,
      archived: item?.fontes_tribunais_estao_arquivadas,
      amount: Number(tribunal?.capa?.valor_causa?.valor),
    };
  });
};

const clientExists = async (clientDTO) => {
  if (!!clientDTO.cpf) {
    const dbClientDataSnapshot = await db
      .collection("Client")
      .where("cpf", "==", clientDTO.cpf)
      .where("user", "==", clientDTO.user)
      .get();

    if (!dbClientDataSnapshot.empty) return dbClientDataSnapshot.docs[0].ref;
    else return null;
  }

  if (!!clientDTO.cnpj) {
    const dbClientDataSnapshot = await db
      .collection("Client")
      .where("user", "==", clientDTO.user)
      .where("cnpj", "==", clientDTO.cnpj)
      .get();

    if (!dbClientDataSnapshot.empty) return dbClientDataSnapshot.docs[0].ref;
    else return null;
  }

  return null;
};

const registerClients = async (processes, userRef) => {
  try {
    const data = processes.map(({ clients }) => clients).flat();
    const clients = removeDuplicate(data, "document");
    const clientRefs = [];

    for await (let client of clients) {
      const clientDTO = {
        user: userRef,
        status: "NOVO",
        isActive: true,
        isPJ: client.isPJ,
        name: client.name,
        isFavorite: false,
        cpf: !client.isPJ ? client.document : "",
        cnpj: client.isPJ ? client.document : "",
        createdAt: getUnixTimestamp(),

        rg: "",
        cep: "",
        sex: "",
        city: "",
        state: "",
        address: "",
        pisNumber: "",
        complement: "",
        profession: "",
        fantasyName: "",
        observation: "",
        nationality: "",
        birthDate: null,
        neighborhood: "",
        maritalStatus: "",
        addressNumber: "",
        corporateReason: "",
        issuingAuthority: "",
        stateRegistration: "",
        municipalRegistration: "",
        emails: [{ title: "", email: "" }],
        phones: [{ number: "", title: "" }],
        companyRepresentative: [
          {
            cep: "",
            cpf: "",
            name: "",
            city: "",
            state: "",
            email: "",
            address: "",
            complement: "",
            observation: "",
            birthDate: null,
            phoneNumber: "",
            neighborhood: "",
            addressNumber: "",
          },
        ],
      };

      const currentClientRef = await clientExists(clientDTO);

      if (!currentClientRef) {
        const newClient = await admin
          .firestore()
          .collection("Client")
          .add(clientDTO);

        const newClientRef = db.collection("Client").doc(newClient.id);
        clientRefs.push(newClientRef);
      } else clientRefs.push(currentClientRef);
    }

    return clientRefs;
  } catch (error) {
    throw error;
  }
};

const registerProcesses = async (processes, userRef, clientsRefs = []) => {
  try {
    const result = [];
    const clients = await getDataFromRefs(clientsRefs);
    // const clients = await getCollectionByUser("Client", userRef);
    console.log("registerProcesses>processes", processes.length);

    const getClientRef = (person) => {
      const dbClientDocumentKey = person.isPJ ? "cnpj" : "cpf";
      const dbClient = clients.find(
        (client) =>
          client.name === person.name &&
          client[dbClientDocumentKey] === person.document
      );

      if (dbClient) return db.collection("Client").doc(dbClient.id);
      else return null;
    };

    for await (let process of processes) {
      const clients = process.clients
        .map((person) => getClientRef(person))
        .filter((item) => !!item);

      const processDTO = { ...process, user: userRef, clients };
      const newProcess = await admin
        .firestore()
        .collection("Process")
        .add(processDTO);

      const newProcessRef = db.collection("Process").doc(newProcess.id);
      result.push(newProcessRef);
    }

    return result;
  } catch (error) {
    throw error;
  }
};

const registerIntimationMonitoring = async (intimations) => {
  const { api_v1, api_token } = await getConfig();

  intimations.forEach(({ registerProcessId }) => {
    handleApiCall(`${api_v1}/monitoramentos`, api_token, "post", {
      tipo: "processo",
      processo_id: registerProcessId,
    })
      .then(() => {})
      .catch((error) => {
        logger.info(
          `+++ intimation Monitoring  (PROCESS: ${registerProcessId}) +++`,
          { structuredData: true }
        );
      });
  });
};

const registerIntimation = async (userRef, processRefs) => {
  const { api_v1, api_token } = await getConfig();

  const result = [];
  let dbProcesses = [];

  if (!processRefs || !processRefs.length) {
    const dbProcessesData = await db
      .collection("Process")
      .where("user", "==", userRef)
      .where("archived", "==", false)
      .get();

    dbProcessesData.docs.forEach((doc) => {
      const data = doc.data();
      dbProcesses.push({ id: doc.id, ...data });
    });
  } else dbProcesses = await getDataFromRefs(processRefs);

  for await (let process of dbProcesses) {
    try {
      const processResponse = await handleApiCall(
        `${api_v1}/processos/numero/${process.cnj}`,
        api_token
      );

      const [{ id }] = processResponse.data;

      const { data } = await handleApiCall(
        `${api_v1}/processos/${id}/movimentacoes?limit=1`,
        api_token
      );

      const [intimation] = data.items;

      const intimationExists = await admin
        .firestore()
        .collection("Intimation")
        .where("registerId", "==", intimation.id)
        .get();

      if (!intimationExists.empty) {
        continue;
      }

      const dbProcessRef = db.collection("Process").doc(process.id);
      const dbProcessData = (await dbProcessRef.get()).data();

      const intimationDTO = {
        user: userRef,
        process: dbProcessRef,
        clients: dbProcessData.clients,

        type: intimation.tipo,
        date: intimation.data,
        registerProcessId: id,
        registerId: intimation.id,
        section: intimation.secao,
        subType: intimation.subtipo,
        snippet: intimation.snippet,
        content: intimation.conteudo,
        complement: intimation.complemento,
        subProccess: intimation.subprocesso,
        categoryText: intimation.texto_categoria,
        read: false,

        processResume: {
          cnj: dbProcessData.cnj,
          courtName: dbProcessData.courtName,
          plaintiff: dbProcessData.plaintiff,
          defendant: dbProcessData.defendant,
          peopleInvolved: dbProcessData.peopleInvolved,
        },
        peopleInvolved: intimation.envolvidos.map((item) => ({
          oab: item.oab,
          name: item.nome,
          registerId: item.id,
          lawyerFor: item.advogado_de,
          typeObject: item.objeto_type,
          typeInvolved: item.envolvido_tipo,
        })),
      };

      await dbProcessRef.set({ registerId: id }, { merge: true });
      await admin.firestore().collection("Intimation").add(intimationDTO);

      result.push(intimationDTO);
    } catch (error) {
      logger.info(`+++ intimation (PROCESS: ${process.cnj}) +++`, error, {
        structuredData: true,
      });
    }
  }

  return result;
};

async function getDataFromRefs(refs) {
  const dataList = [];

  for (const ref of refs) {
    try {
      const docSnapshot = await ref.get();
      if (docSnapshot.exists) {
        const data = docSnapshot.data();
        dataList.push({ id: ref.id, ...data });
      } else {
        console.log("Documento não encontrado para a referência:", ref.id);
      }
    } catch (error) {
      console.error("Erro ao buscar documento:", error);
    }
  }

  return dataList;
}
//#endregion utils

// #region Database
const getCollectionData = async (collectionName) => {
  const snapshot = await db.collection(collectionName).get();
  const result = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    result.push({ id: doc.id, ...data });
  });

  return result;
};

const getCollectionByUser = async (collectionName, userRef) => {
  const snapshot = await db
    .collection(collectionName)
    .where("user", "==", userRef)
    .get();

  const result = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    result.push({ id: doc.id, ...data });
  });

  return result;
};

const corsSetings = (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, PUT");
  response.set("Content-Type", "application/json; charset=utf-8");
  response.set("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return true;
  }

  response.setHeader("Content-Type", "application/json");

  return false;
};

// #endregion Database

exports.equalizeUserBase = onRequest(
  { timeoutSeconds: 500 },
  async (request, response) => {
    logger.info("+++ INIT EQUALIZE USER BASE +++", { structuredData: true });

    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    try {
      let data = [];
      const isDevMode = !!request?.body?.isDevMode;
      const userRef = db.collection("User").doc(request.body.userId);
      const userDocuments = await getCollectionByUser("UserOAB", userRef);

      if (isDevMode) data = equilizeUserBaseMock;
      else data = await buildUserProcessList(userDocuments);

      const processes = buildUserProcessModel(data, userDocuments);

      const clients = await registerClients(processes, userRef);
      await registerProcesses(processes, userRef, clients);

      const intimations = await registerIntimation(userRef);
      const intimationMonitoring = intimations.slice(0, 200);

      await registerIntimationMonitoring(intimationMonitoring);

      response.json({
        message: "success",
        data: {
          allProcessesCount: data.length,
          activeProcessesCount: processes.length,
        },
      });
    } catch (error) {
      logger.error("+++ ERROR EQUALIZE USER BASE +++", error, {
        structuredData: true,
      });

      response.status(400).json({ message: "error", error });
    }
  }
);

exports.equalizeUserIntimationBase = onRequest(
  { timeoutSeconds: 540 },
  async (request, response) => {
    logger.info("+++ INIT equalizeUserIntimationBase +++", request.body, {
      structuredData: true,
    });

    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    try {
      const userRef = db.collection("User").doc(request.body.userId);
      const result = await registerIntimation(userRef);

      const intimationMonitoring = result.slice(0, 200);
      registerIntimationMonitoring(intimationMonitoring);

      response.json({
        message: "success",
        data: { count: intimationMonitoring.length },
      });
    } catch (error) {
      logger.error("+++ ERROR equalizeUserIntimationBase +++", error, {
        structuredData: true,
      });

      response.status(400).json({ message: "error", error });
    }
  }
);

exports.callbackMonitoring = onRequest((request, response) => {
  logger.info("+++ INIT MONITORING +++", request.body, {
    structuredData: true,
  });
  response.send("callback monitoring works");
});

const puppeteer = require("puppeteer");
exports.exportPdf = onRequest({ memory: "1GiB" }, async (request, response) => {
  try {
    console.log("+++ INIT EXPORT PDF +++", request.body);
    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    const { content, fileName } = request.body;
    const isLocalHost = request.headers.host.includes("localhost");

    const puppeteerConfig = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };

    if (!isLocalHost)
      puppeteerConfig.executablePath = puppeteer.executablePath();

    const browser = await puppeteer.launch(puppeteerConfig);
    const page = await browser.newPage();

    await page.setContent(content, { waitUntil: "domcontentloaded" });
    const pdfBuffer = await page.pdf({ format: "A4", landscape: false });

    await browser.close();

    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName || "output"}.pdf"`
    );
    response.setHeader("Content-Type", "application/pdf");

    response.send(pdfBuffer);
  } catch (error) {
    console.error("+++ [EXPORT PDF] +++", error);
    response.status(500).json({
      message: "Error",
      data: error.message,
    });
  }
});

exports.updateProcessArchiving = onRequest(async (request, response) => {
  try {
    console.log("+++ INIT updateProcessArchiving +++", request.body);
    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    const { archived, processId, userId } = request.body;
    const { api_v1, api_token } = await getConfig();

    const dbUserRef = db.collection("User").doc(userId);
    const dbProcessRef = db.collection("Process").doc(processId);
    const dbProcessData = (await dbProcessRef.get()).data();

    if (dbProcessData.archived === archived) {
      response.json({
        message: "O processo já está no status atual",
        data: {},
      });

      return;
    }

    await dbProcessRef.update({ archived });
    await admin
      .firestore()
      .collection("historicalProcesses")
      .add({
        userRef: dbUserRef,
        cnj: dbProcessData.cnj,
        processRef: dbProcessRef,
        datetimeAction: new Date(),
        typeAction: `Processo ${archived ? "arquivado" : "reativado"}`,
      });

    if (archived) {
      const data = await getMonitoring();

      const [monitoring] = data.filter(
        (item) => item.processo_id === dbProcessData.registerId
      );

      if (!monitoring) {
        response.status(404).json({
          message: "Monitoramento não encontrado",
          data: {},
        });

        return;
      }

      await handleApiCall(
        `${api_v1}/monitoramentos/${monitoring.id}`,
        api_token,
        "delete"
      );
    } else {
      handleApiCall(`${api_v1}/monitoramentos`, api_token, "post", {
        tipo: "processo",
        processo_id: dbProcessData.registerId,
      });
    }

    response.json({
      message: "success",
      data: {},
    });
  } catch (error) {
    console.error("+++ [updateProcessArchiving] +++", error);
    response.status(500).json({
      message: "Error",
      data: error.message,
    });
  }
});

exports.seachProcess = onRequest(async (request, response) => {
  try {
    console.log("+++ INIT seachProcess +++", request.body);
    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    const { cnj, userId, isDevMode } = request.body;
    const { api_v2, api_token } = await getConfig();

    const dbUserRef = db.collection("User").doc(userId);
    const userDocuments = await getCollectionByUser("UserOAB", dbUserRef);

    let processResponse = {};

    if (isDevMode) processResponse = searchProcessMock;
    else {
      const { data } = await handleApiCall(
        `${api_v2}/processos/numero_cnj/${cnj}`,
        api_token
      );

      processResponse = data;
    }

    if (!Object.keys(processResponse).length) {
      response.status(404).json({
        message: "Processo não encontrado",
        data: {},
      });
      return;
    }

    const processes = buildUserProcessModel([processResponse], userDocuments);
    const dbClients = await registerClients(processes, dbUserRef);
    const dbProcess = await registerProcesses(processes, dbUserRef, dbClients);
    const dbIntimation = await registerIntimation(dbUserRef, dbProcess);
    await registerIntimationMonitoring(dbIntimation);

    response.json({
      message: "success",
      data: dbProcess,
    });
  } catch (error) {
    console.error("+++ [seachProcess] +++", error);
    response.status(500).json({
      message: "Error",
      data: error.message,
    });
  }
});

exports.getUserDocumentPaginate = onRequest(async (req, res) => {
  try {
    const isPreflight = corsSetings(req, res);
    if (isPreflight) return;

    const { currentPage, itemsPerPage, userId, documentPathId, filter } =
      req.body;

    const userRef = db.collection("User").doc(userId);
    const documentPathRef = db.collection("DocumentPath").doc(documentPathId);

    if (!currentPage || !itemsPerPage) {
      return res.status(400).json({ error: "Parâmetros inválidos." });
    }

    const page = parseInt(currentPage, 10);
    const perPage = parseInt(itemsPerPage, 10);

    const startIndex = (page - 1) * perPage;

    let query = db.collection("Document");
    query = query.where("users", "array-contains", userRef);
    query = query.where("documentPath", "==", documentPathRef);

    if (filter?.name) query = query.where("name", "==", filter.name);

    if (filter?.processCnj)
      query = query.where("processCnj", "==", filter.processCnj);

    if (filter?.clientDocument)
      query = query.where("clientDocument", "==", filter.clientDocument);

    if (filter?.uploadDate) {
      const dateToFilter = new Date(filter.uploadDate);

      const startOfDay = new Date(dateToFilter);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(dateToFilter);
      endOfDay.setHours(23, 59, 59, 999);

      query = query
        .where("dateCreation", ">=", startOfDay)
        .where("dateCreation", "<=", endOfDay);
    }

    const itemsSnapshot = await query.offset(startIndex).limit(perPage).get();

    const items = [];
    itemsSnapshot.forEach((doc) => {
      items.push({ id: doc.id, ...doc.data() });
    });

    const totalItemsSnapshot = await query.get();
    const totalItems = totalItemsSnapshot.size;
    const totalPages = Math.ceil(totalItems / perPage);

    const transformedData = items.map((item) => {
      const dateCreation = new Date(item.dateCreation._seconds * 1000)
        .toISOString()
        .split("T")[0];

      return {
        id: item.id,
        dateCreation,
        url: item.url,
        name: item.name,
        processCnj: item.processCnj,
        templateHTML: item.templateHTML,
        clientDocument: item.clientDocument,
        client: item?.client?._path?.segments[1] || "",
        process: item?.process?._path?.segments[1] || "",
        documentPath: item?.documentPath?._path?.segments[1] || "",
        users: item.users.map((user) => user._path.segments[1] || ""),
      };
    });

    const result = {
      page,
      totalItems,
      totalPages,
      pageSize: perPage,
      filter,
      items: transformedData,
    };

    return res.status(200).json(result);
  } catch (error) {
    console.error("Erro:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

exports.equalizeUserIntimationFree = onRequest(
  { timeoutSeconds: 500 },
  async (request, response) => {
    logger.info("+++ INIT EQUALIZE USER BASE +++", { structuredData: true });

    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    try {
      let data = [];
      const userRef = db.collection("User").doc(request.body.userId);

      const processes = await getCollectionByUser("Process", userRef);

      const intimations = await registerIntimation(userRef);
      const intimationMonitoring = intimations.slice(0, 200);

      await registerIntimationMonitoring(intimationMonitoring);

      response.json({
        message: "success",
        data: {
          allProcessesCount: data.length,
          activeProcessesCount: processes.length,
        },
      });
    } catch (error) {
      logger.error("+++ ERROR EQUALIZE USER BASE +++", error, {
        structuredData: true,
      });

      response.status(400).json({ message: "error", error });
    }
  }
);

exports.equalizeUserBaseGold = onRequest(
  { timeoutSeconds: 500 },
  async (request, response) => {
    logger.info("+++ INIT EQUALIZE USER BASE +++", { structuredData: true });

    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    try {
      let data = [];
      const isDevMode = !!request?.body?.isDevMode;
      const userRef = db.collection("User").doc(request.body.userId);
      const userDocuments = await getCollectionByUser("UserOAB", userRef);

      if (isDevMode) data = equilizeUserBaseMock;
      else
        data = await buildUserProcessListByPlan(
          userDocuments,
          60
        );

      const processes = buildUserProcessModel(data, userDocuments);

      const clients = await registerClients(processes, userRef);
      await registerProcesses(processes, userRef, clients);

      const intimations = await registerIntimation(userRef);
      const intimationMonitoring = intimations.slice(0, 200);

      await registerIntimationMonitoring(intimationMonitoring);

      response.json({
        message: "success",
        data: {
          allProcessesCount: data.length,
          activeProcessesCount: processes.length,
        },
      });
    } catch (error) {
      logger.error("+++ ERROR EQUALIZE USER BASE +++", error, {
        structuredData: true,
      });

      response.status(400).json({ message: "error", error });
    }
  }
);

exports.equalizeUserBasePremium = onRequest(
  { timeoutSeconds: 500 },
  async (request, response) => {
    logger.info("+++ INIT EQUALIZE USER BASE +++", { structuredData: true });

    const isPreflight = corsSetings(request, response);
    if (isPreflight) return;

    try {
      let data = [];
      const isDevMode = !!request?.body?.isDevMode;
      const userRef = db.collection("User").doc(request.body.userId);
      const userDocuments = await getCollectionByUser("UserOAB", userRef);

      if (isDevMode) data = equilizeUserBaseMock;
      else
        data = await buildUserProcessListByPlan(
          userDocuments,
          400
        );

      const processes = buildUserProcessModel(data, userDocuments);

      const clients = await registerClients(processes, userRef);
      await registerProcesses(processes, userRef, clients);

      const intimations = await registerIntimation(userRef);
      const intimationMonitoring = intimations.slice(0, 200);

      await registerIntimationMonitoring(intimationMonitoring);

      response.json({
        message: "success",
        data: {
          allProcessesCount: data.length,
          activeProcessesCount: processes.length,
        },
      });
    } catch (error) {
      logger.error("+++ ERROR EQUALIZE USER BASE +++", error, {
        structuredData: true,
      });

      response.status(400).json({ message: "error", error });
    }
  }
);
